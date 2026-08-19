# 監視・配送系の異常時対応（参照専用）

このファイルは `SKILL.md` の「ワーカーからの報告の受信（msg-poll）」「worker への指示配送（Inbox Supervisor）」「PR検出」から参照される。**正常系ではこのファイルを読む必要はない。** 異常な通知を受け取った・多重起動を疑った・レビューが進まない、といった場面でだけ該当節を開く。

## install後の常駐入れ替え

`node scripts/install.js` は、共有スクリプトの配布後に `restart-residents.js` を自動で呼び出す。稼働中の常駐は起動時にロードしたJSを保持するため、installだけで完了したと判断せず、installの出力を確認する。対象workspaceを解決できない単独インストールでは、常駐の対象を推測せず入れ替えをスキップする。

`restart-residents.js` の出力は、常駐ごとの `RESIDENT script=<name> status=<status>` 行と、Monitor再接続が必要な場合の `MONITOR_REATTACH_REQUIRED script=<name> command=<command>` 行で構成される。statusの詳細な意味は `node scripts/restart-residents.js --help` を一次情報とする。

`MONITOR_REATTACH_REQUIRED` が出た常駐は、各行の `command=` をMonitorで実行して同じ出力先へ張り直す。Monitor出力を持つ `msg-poll.js` / `poll-pr.js` / `poll-reviews.js` はdetachedで起動しない。特に `msg-poll.js` はプロセスが生きているだけではワーカー報告が届かず、Monitorの張り直し完了まで次のタスクへ進めない。

installまたはrestart CLIが非ゼロ終了した場合、registryの読み取り・停止・起動確認のいずれかが未確認である可能性がある。結果を人間に報告して判断を仰ぎ、セッション再起動依頼で置き換えない。

## inbox監視の重複復旧

「重複しているかもしれない」と気づいた瞬間に片方を反射的に止めてはならない。以下の順で確認してから対処する：

1. **実数を確認する**: `node "{{SCRIPTS_PATH}}/process-lifecycle.js" sweep --workspace $WORKSPACE --dry-run` を実行し、`script=msg-poll.js` かつ `worker=-`（orchestrator inbox 監視）のエントリが実際に複数生存しているかを確認する。1本しかなければ「重複」ではない。誤って停止しない。**`--dry-run` は必須。指定しないと確認のつもりが実際にkillしてしまう。**
2. **複数確認できた場合のみ**、最も新しく起動したもの以外を残す方針で、古いMonitorタスクを`TaskStop`等で停止する。停止対象を誤らないよう、停止前に該当タスクが本当に `msg-poll.js orchestrator` を実行しているか確認する。
3. 停止した分の registry エントリ（`.gh-maestro/pids/<PID>.json`）は、プロセスが死ねば次回の生存確認で自動的に無視される。**`sweep`（`--dry-run` なし）を対象を絞らずに実行しない**こと。無条件のsweepは他のMonitor（poll-pr.js・poll-reviews.js等）を含む登録済みの生存プロセスも巻き込んで停止させる。
4. 残った1本が生きていることを確認してからセッションを継続する。届いていたはずのメッセージを見逃していないか、`gh issue view <N> --comments` で直近のワーカー報告を確認する。

Inbox Supervisor（`inbox-supervisor.js`）側の重複を疑った場合も、自動起動のため通常は発生しないが、疑いがあれば上記と全く同じ手順を `script=inbox-supervisor.js` を対象に行う。

## ワーカーの異常終了通知

ワーカーのプロセスが**非ゼロ終了**（起動失敗・クラッシュ等）で終わると、終了フック（`worker-exit-hook.js`）が自動的に `⚠️ 起動失敗または異常終了: exit code <N>...` というメッセージを orchestrator の inbox に投稿する（正常終了 exit 0 では通知されない）。「まだ報告が来ないだけ」と待ち続けてはならない。

この通知を鵜呑みにせず、`node "{{SCRIPTS_PATH}}/worker-status.js" status --workspace $WORKSPACE --worker-name <workerName>` で実際に死んでいるか確認してから人間に伝える。生存していれば誤通知として扱い、原因は調査しない。

## 監視プロセスの異常終了通知（msg-poll / poll-pr / poll-reviews）

常駐監視（`msg-poll.js` / `poll-pr.js` / `poll-reviews.js`）が**非ゼロ終了**（クラッシュ等）で終わると、プロセス自身が `⚠️ 監視プロセス <script> が異常終了しました（exit code <N>）...` という通知を orchestrator の inbox に投稿する（正常終了 exit 0 = SIGINT/SIGTERM/`PR_MERGED`/`PR_CLOSED` では通知されない）。**`msg-poll.js`（orchestrator モード）と `inbox-supervisor.js` は親セッション消滅を exit 0 ではなく exit 3 で自滅し、watchdog が専用の「親セッション消滅による自動終了」通知を送る**（下記「inbox監視の沈黙」参照。`poll-pr.js` / `poll-reviews.js` は親セッション消滅を従来どおり exit 0 で終了し、通知は出ない）。

さらに、それらの監視プロセスを張った **Monitor が終了したことも、監視プロセスの異常終了のアラーム**である。`PR_MERGED` / `PR_CLOSED`（とそれに続く `PR_CLOSED_RESUMED`）を出力して終了したときだけ意図した終了であり、それ以外の終了（特に非ゼロ終了）は異常を意味する。Monitor の終了はバックグラウンドの task 通知として届くため、**見落としやすい**。`poll-pr.js` を張った Monitor が終了したのに `PR_CLOSED_RESUMED` も `PR_MERGED` も続いていない場合は、監視が止まったと疑う。

通知を受けたら、どの監視が止まったかを特定してから確認する:

1. `node "{{SCRIPTS_PATH}}/process-lifecycle.js" status --workspace $WORKSPACE --script <script名>`（msg-poll.js / poll-pr.js / poll-reviews.js）を実行し、`running:false` かどうかで該当プロセスが実際に死んでいるかを確認する（誤通知の可能性を排除）。
2. 止まった監視が本当に必要なら再起動する。`poll-pr.js` は下記「PR監視・Review Managerの再起動」、`msg-poll.js` は SKILL.md の「ワーカーからの報告の受信（msg-poll）」の起動規約に従う。
3. 監視が止まっていた間の機能停止（検出し損ねた PR・届かなかったメッセージ）を確認し、人間に報告する。**機械は自動復旧しない**（再起動判断は orchestrator が行う）。

## inbox監視の沈黙（通知が鳴らないまま止まる）

`msg-poll.js orchestrator` は親セッション死亡検知（dead-man's switch）で **exit 3** で自滅する。自滅の経路では role lease が解放され、watchdog が「親セッション消滅による自動終了」の専用通知を送り、Monitor も異常終了（FAILED）として終了するため、**通常は沈黙せず通知が届く**。死のスイッチの判定は PID の再利用（起動時刻照合）にも正しく反応し、親セッションが死んだ後にその PID が別プロセスに使い回されていても「生きている」と誤判定して居座り続けない。

ただし、クラッシュ・強制終了（`taskkill /F` 等）は自滅経路を経ないため、通知も lease 解放も行われない。また自動復活機構は存在しないため、プロセスが死んだままとなる。

**この状態は「反応が無い」という体感からしか入れない。** ワーカーの報告・PR 作成・レビュー完了のいずれかを待っていて、来ないと感じたら以下を実行する。

0. **まず自分が Monitor を張ったかを確認する。プロセスの生死より先にこれを見る。** `msg-poll.js orchestrator` は orchestrator 自身が Monitor で起動する規約であり、自動起動は行われない。**プロセスが生きていることと、その出力が自分に届くことは全く別である。** 通知が自分のセッションに届くのは、SKILL.md「ワーカーからの報告の受信（msg-poll）」の規約どおり自分で Monitor を張った場合だけであり、張っていなければ画面には何も出ない。
   - **判定方法**: このセッションで自分が Monitor ツールを呼んで `msg-poll.js orchestrator` を起動したか、記憶ではなく会話の履歴で確認する。同じく `poll-pr.js` の Monitor も張ったか確認する。張っていなければ、それが沈黙の原因である。以降の手順に進まず、SKILL.md の起動規約に従って張る。
   - **実障害**: orchestrator が Monitor を一本も張らないままコーダーを起動し、コーダーからの報告・PR 作成が一切画面に出ないまま放置した。`pids/` にプロセスは居たため「ポーリングは生きています」と報告し、原因を配送側のバグと誤認して diagnostician への委譲を提案した。実際は自分の起動規約違反であり、確認すべきだったのは自分が Monitor を張ったかどうかだけだった。**「プロセスは生きている」を「通知は届く」の根拠にしてはならない。**

1. **生死を `process-lifecycle.js status` で確認する。** `node "{{SCRIPTS_PATH}}/process-lifecycle.js" status --workspace $WORKSPACE --script msg-poll.js` を実行する。`running:false` なら死んでいる。
   - **`ps` の node プロセス一覧や `.gh-maestro/inbox-supervisor-autostart.log` で判断してはならない。** それらは worker 配送を行う `inbox-supervisor.js` のもので、msg-poll が死んでいても正常に動き続ける（`SCAN_START` / `SCAN_END:<n>:0` を出し続ける）。この混同で「ポーラーは生きている」と誤報告した実例がある。
   - **`running:true` であっても、それは「通知が自分に届く」ことを意味しない。** 手順 0 を飛ばしてここだけを見ると、Monitor 未起動という本当の原因を素通りする。
2. **lease の残骸に騙されない。** `.gh-maestro/leases/resident-role-msgpoll-orchestrator.json` はクラッシュ・強制終了（自滅経路を経ない場合）で解放されずに残ることがある。lease があってもプロセスは死んでいる。むしろ「PID registry に居ないのに lease が残っている」組合せは、この経路で死んだ証拠である。
3. **再起動する。** アラーム（watchdog 通知・Monitor の異常終了）を受けた場合は判断を挟まず、SKILL.md「ワーカーからの報告の受信（msg-poll）」の起動規約に従い、Monitor で `msg-poll.js orchestrator` を起動し直す（「1回だけ起動」は生きている間の話であり、死んだ後の再起動はこれに反しない）。
4. **止まっていた間に取りこぼした通知を確認し、人間に報告する。** 停止中に投稿されたコメントは既読にならないため、再起動後に順次 `NEW_MESSAGE` として届く。

## ワーカーの実行ログ

ワーカーは画面を持たない。標準出力/標準エラーは `$WORKSPACE/.gh-maestro/worker-logs/<workerName>.log` へ**実行中から逐次**書かれる。1ワーカー1ファイルで、初回起動もresumeも同じファイルに追記される。

**既定ではこのログを読まない。** ワーカーの報告は Issue コメントとして届き、それが唯一の配送根拠である。ログは冗長で、読むだけでコンテキストとトークンを消費する。

読むのは次の場合だけ:

- 異常終了通知（上記）を受け取り、原因を切り分けるとき
- 配送断念通知を受け取ったとき
- ワーカーが長時間まったく反応せず、生きているか確かめたいとき

このときは `Read` でログを読む。

実行中の経過をどうしても追う必要がある場合（長時間ワーカーが本当に進んでいるかの確認等）に限り、**フィルタ付きで**一時的に Monitor を張る。用が済んだら `TaskStop` で止める。これは「ワーカーからの報告の受信（msg-poll）」の単一起動規約とは別枠の、使い捨ての監視である。

```
tail -f "$WORKSPACE/.gh-maestro/worker-logs/<workerName>.log" \
  | grep -E --line-buffered "<進捗の目印>|Error|Traceback|FAILED|Killed|OOM"
```

このコマンド形には3つの必須要素がある。どれを落としても監視が無言で機能しなくなる。

- **`--line-buffered`**: 付けないと一致行が grep のバッファに溜まって通知が飛ばない
- **失敗シグネチャを含める**: 成功の目印だけを拾うフィルタは、クラッシュ・ハング・異常終了のとき何も出さない。**沈黙は正常を意味しない**——「まだ動いている」と区別がつかなくなる。失敗側を列挙しきれないなら、ノイズが増えてもフィルタを広く取る
- **生ログを流さない**: `tail -f` 単体（grep なし）は1行ごとに通知が飛んでチャットを埋め、Monitor 自体が過剰イベントで自動停止する

Monitor のコマンドは Bash 環境で実行される（Windows でも Git Bash 経由で上記がそのまま動く）。

なお「ワーカーが終わったら教えてほしい」という**単発の通知**が欲しいだけなら Monitor は使わない。ワーカーの完了は PR 検出と inbox への報告で分かる。

## 配送断念の通知（Inbox Supervisor 自身による検知）

`inbox-supervisor.js` はresumeでプロセスを起動した直後、短い猶予を置いてからPIDで生存を再確認する。**spawnが成功しPIDが返ったことは、プロセスが生存し続けることを保証しない**（実障害: 起動コマンド自体は成功と報告されたのに、起動直後のクラッシュやホスト環境自体の不安定化で直後に消滅し、`DELIVERED`と誤記録されたままワーカーが無応答で放置された）。この再確認で消失が判明した場合はresume失敗として扱い、バックオフしながらリトライする。**リトライを最大回数（5回）まで尽くしても配送できなかった場合、`inbox-supervisor.js` 自身が `msg-send.js` 経由でorchestratorのinboxに配送断念を通知する**（`⚠️ ワーカー "<name>" へのメッセージ配送に5回失敗し断念しました...`）。

これは「ワーカーの異常終了通知」（終了フックによる非ゼロ終了検知）とは別の検知経路である。終了フックはワーカープロセスが**自分でexitできた場合**にしか働かない。プロセスが強制終了された、あるいはホスト環境ごと突然消滅して終了フックが実行される機会すら無かった場合はこの経路では検知できず、配送断念通知が最後の砦になる。どちらの通知を受け取った場合も、そのワーカーは作業を完了できていない。「まだ報告が来ないだけ」と待たず、原因を切り分けて人間に伝える。

## resume応答の送信忘れに対する自動代理送信（全エージェント種別共通）

resumeで再開されたワーカーが、届いた指示に対して正しく考えて回答を作ったのに、`msg-send.js` を一度も実行せずにセッションを終えてしまい、回答がGitHubに一切投稿されない実障害が起きた（issue-253-dashboard-impl、claude-ds）。ワーカーは記憶を持たない使い捨てセッションであり、通信規約の文言指示だけでは「地の文で答えて終わる」誤りを防げなかった。

これはClaude Code固有の対策では不十分である。**gh-maestroはworkerのエージェント種別を`skillAgentMap`/`config.json`でいつでも差し替えられる**ため（例: `gh-maestro-coder`が`claude-ds`ではなく`agy`になる設定も現実に存在する）、特定エージェントの機能に依存しない対策が必要になる。そこで、全エージェントに共通する唯一の事実——「非対話モードで起動され、答えは標準出力に出る」——を使う。resume起動時にワーカーの標準出力/標準エラーをファイルにも複製保存し（`scripts/agent-exec.js`のcaptureLogPath）、ワーカー終了時（`worker-exit-hook.js`）に**実際にGitHubへ返信が届いたかを直接確認**する。届いていなければ、複製しておいた出力の末尾を、hookが自動的に `msg-send.js` 経由で代理送信する。代理送信されたコメントは本文冒頭の `⚠️ [自動代理送信: ...]` という注記で見分けられる。

この安全網はエージェント種別を問わず全resume応答に効く（新規起動の完了報告要否はスキルごとに異なるため対象外——resumeへの応答のみ対象）。代理送信を受け取ったら、ワーカーは内容的には正しく応答できていたが送信の作法だけを誤った、と理解した上で内容を評価すればよい。頻発する場合は該当ワーカーのスキル記述（通信規約の遵守）に問題がある可能性を疑う。

## 新規起動での投稿漏れ（resumeで完遂させる。ログを読んで代行しない）

上記の自動代理送信は**resumeへの応答**にしか効かない。ワーカーの**初回起動**が調査・作業自体は完了させたのに`msg-send.js`を一度も実行せずプロセスが終了した場合は対象外であり、安全網が働かない。

この状態（プロセスは終了しているのに該当Issueへの報告コメントが見当たらない）に気づいた場合、**orchestrator自身が`$WORKSPACE/.gh-maestro/worker-logs/<workerName>.log`を読んで内容を回収し、代わりに`comment-issue.js`や`msg-send.js`で代理投稿してはならない**。実際にこれをやって、数百行のログ全文を読み込み、巨大な本文を手作業で再構成してGitHubへ再投稿しようとし、大量のトークンを浪費した上に投稿自体もheredocの構文エラーで失敗した実障害がある。

正しい対処は、そのワーカー宛てに短いresumeメッセージを送るだけである:

```sh
node "C:\Users\amg\.gh-maestro\scripts/msg-send.js" --issue <N> --skill <role> --workspace $WORKSPACE --stdin <<'EOF'
報告投稿（msg-send.js）を怠っているようです。まとめた内容を必ずmsg-send.js経由でorchestratorへ投稿してください。
EOF
```

ワーカーは記憶を保持したまま生きている（単に`msg-send.js`の呼び出しを忘れただけ）ため、resumeで自分のセッション文脈から報告内容を組み立てて正しく投稿できる。orchestratorはいつも通りinbox監視で`NEW_MESSAGE`を待てばよい。ログを読むのは上記「ワーカーの実行ログ」に列挙した限定的なケース（異常終了通知・配送断念通知を受けた原因切り分け等）に限る。

## Inbox Supervisorの起動は自動（手動起動は不要）

**`inbox-supervisor.js` の起動はorchestratorが覚えて手動で行うものではない。** `spawn-worker.js`（ワーカー作成時）と `msg-send.js`（ワーカー宛て送信時）の両方が、内部で自動的に起動を確認・保証する（`scripts/shared/ensure-inbox-supervisor.js`）。orchestratorはこのプロセスの起動を意識する必要がない——Bashツールで明示的に起動する手順は存在しない。

これは意図的な設計変更である。以前は「worker起動前にBashツールで手動起動すること」という指示だったが、**起動を怠ると配送が一切行われず、しかもエージェントの記憶に依存する経路だったため、実際に起動を忘れて配送が長期間止まる実障害が発生した**。決定的なコード（spawn-worker.js/msg-send.js）側で起動を保証する形に修正済み。

`spawn-worker.js`/`msg-send.js`は起動を試みる前に、同じworkspaceを監視中の生存プロセスがいないか（`ensureInboxSupervisorRunning`内で）確認し、いれば起動そのものをスキップする。万一この事前チェックをすり抜けても、`inbox-supervisor.js`自身が起動時に同じ確認を行い、既に監視中のプロセスを検知すれば新規プロセスを起動せずexit 1で終了する（多重起動防止の二重の安全網）。**この自動復活は有界である**: 起動を試みた時点を `.gh-maestro/inbox-supervisor-autostart-attempt.json` に記録し、クールダウン（既定5分）中は再試行しない（連続失敗時に呼び出しのたびに子プロセスとログが増え続けるのを防ぐ。生存を観測したら記録は消える）。

**dead-man's switch（親セッション死活監視）が監視するPIDは、起動を呼び出した`spawn-worker.js`/`msg-send.js`自身が、まだ生存しているうちに解決して`--session-pid`で明示的に子へ渡す。** `inbox-supervisor.js`はdetachedかつfire-and-forgetで起動されるため、起動直後には呼び出し元（使い捨てのCLIプロセス）が既に終了していることがある。もし子自身に解決を委ねると、子の直近の親（=その使い捨てCLI）が消えた時点でそこより上のセッション本体への遡行が失敗し、消えて当然の使い捨てCLIを「オーケストレーターセッション本体」と誤認して、オーケストレーターが生きているにもかかわらず起動直後（3スキャン周期以内）に自滅する実障害があった。この理由により、この解決処理を子（`inbox-supervisor.js`）側に戻す変更は行わないこと。

**`migrate-records.js` の移行実行中は、inbox-supervisor の自動起動が一時的に抑制される（Issue #256）。** 移行対象の scope が `inbox-supervisor` または `all` のとき、移行ツール自身が稼働中の inbox-supervisor を検知・停止し、`.gh-maestro/.migration-in-progress` マーカー（所有プロセスの pid・起動時刻を記録）を立てて自動起動を抑止した状態で移行し、完了時にマーカーを削除する。マーカーが存在する間、`ensureInboxSupervisorRunning`（spawn-worker.js / msg-send.js 経由）は起動を見送る。マーカーは所有プロセスの生存を確認するため、移行プロセスが強制終了（クラッシュ・OS終了等）してマーカーが残った場合は stale として無視され、自動起動は永久に抑止されず自己回復する。移行後の再開は既存の自動起動機構が次に必要とした時点で行われるため、orchestrator・人間がプロセスを手動で止めたり立ち上げたりする必要はない。`--dry-run` では停止もマーカー作成も行われない（プレビューのみ）。

## resume配送の失敗

workerへの配送のうち、**相手のプロセスが稼働中（作業中）で見送っているだけの状態は、いくら長引いても「失敗」としてカウントされない**（休止するまで無期限に待つ）。resumeを実際に試みて失敗した場合（worktree消失・プロセス起動失敗等）のみ、5回の指数バックオフ再試行の末に配送を諦める。workerに指示を送ったのに長時間反応しない場合、`.gh-maestro/inbox-supervisor-autostart.log`（自動起動時のログ）または起動元セッションのバックグラウンド出力を確認し、`DELIVERY_FAILED:<workerName>:<commentId>:resume-failed`（`pending`ではなく`resume-failed`であること）の有無とエラー内容を確認すること。

## PR監視・Review Managerの再起動

Monitor が落ちた等で `poll-pr.js` を再起動する必要があるが、**そのPRのレビューは既に済んでいる／再レビューは不要**という場合は、`--no-review-manager` を付けて起動する。PR検出時に Review Manager を起動せず、レビューコメント・マージ状態の監視だけを再開する。これを付けずに再起動すると、検出のたびにレビューが蒸し返されて quota を浪費する。

監視中に該当PRが `CLOSED`（却下・キャンセル）された場合は、`poll-reviews.js` が `PR_CLOSED` を出力して終了し、`poll-pr.js` は新 PR の検出へ復帰する（`PR_CLOSED_RESUMED` を出力して同じ Monitor が継続する）。**CLOSED のために `poll-pr.js` を再起動する必要はない**——再起動すると、却下済みPRではなく新 PR の検出からやり直すことになり、機能は同じだが無駄になる。CLOSED は新 PR を待つ状態として扱う（Issue #289）。再起動が本当に必要なのは、監視プロセスが異常終了したとき（上記「監視プロセスの異常終了通知」）だけである。

```sh
node "{{SCRIPTS_PATH}}/poll-pr.js" <ISSUE> --no-review-manager --workspace $WORKSPACE --base-branch $BASE_BRANCH
```

Review Managerが起動しなかった、または途中で失敗した場合は、start-review-manager.js で起動・再起動できる。レビューが進まないときは `$WORKSPACE/.gh-maestro/worker-logs/issue-<N>-review-manager-pr-<PR>.log` を確認し、失敗していれば再起動する（`<N>`は現在のIssue番号=`$ISSUE`）。

```sh
node "{{SCRIPTS_PATH}}/start-review-manager.js" $PR $REPO $WORKSPACE $ISSUE
```

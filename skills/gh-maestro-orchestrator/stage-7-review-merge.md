---
signals:
  - notify:PR_DETECTED
  - notify:PR_PUSH
---
# 工程 7. レビューとマージ【必須】

このファイルは、同じIssueを担当するorchestratorが工程7で実行する手順の正本である。工程番号・必須／任意・入口／待機／遷移を確認して進める。人間への発言と工程横断の不変条件はSKILL.mdに従う。

<!-- gh-maestro-structure: middle-items=6 -->

入口: 通常経路のPR_DETECTEDを受けたとき（軽量PRはlightweight-pr.mdに従う）。待つもの: Review Manager、テスト、CI、レビューコメント、PR状態の通知と、指摘への番号指定・マージ判断という人間の判断。次: PR_MERGEDを受けて工程8。

中項目の番号は、人間に名乗る場面に振る。7-[1/6]の監視はorchestratorの内部作業で、人間に声をかけるのは監視中の事象を伝えるとき、7-[2/6]〜7-[6/6]の場面である。7-[1/6]を済ませたことは、7-[5/6]の提示に監視の結果を載せることで示す。

#### 7-[1/6] PR検出とレビュー監視【必須】

PR検出後、plugin monitorから届くレビュー・テスト・CI・PR状態の通知を処理する。新しいMonitorやポーリングプロセスをここで起動してはならない。通知名ごとの一次対応は「イベントの受け口」に集約する。監視中の事象（ベースブランチ違い、GitHub accessの劣化、PRのクローズなど）を人間へ伝えるときは `工程7-[1/6]` と名乗る。

`poll-pr.js`はレビュー観点を一切選ばない。通常経路ではPR検出時にReview Managerを全観点で起動する。軽量PR（`--no-review-manager` と `--no-review-events` の併用）では起動しない。**観点を絞り込むかどうかの判断はorchestratorの責務ではなく、Review Manager自身が実際のPR diffを見た上で行う**（詳細は`skills/gh-maestro-reviewer/SKILL.md`参照）。

通常経路のPR検出後、`poll-pr.js` は対象PRのHEADと対応するcoder/senior-coder worktreeを照合して `slow` 層を非同期起動する。`poll-reviews.js` から `PR_PUSH:<sha>` を受け取るたび、その新しいHEADに対してもslowを非同期予約する。Review Managerを起動しない通常監視の復旧経路やrevert用PRでもこの動作を維持する。軽量PR（`--no-review-manager` と `--no-review-events` の併用）では初回検出・push後ともslow層を起動しない。レビュー監視の起動・通知をslow完了まで同期的に待たせてはならない。同じPR/HEAD/layerはstate予約で二重実行しない。slow層の `test.layers.slow.dynamicConcurrency` が宣言されている場合、起動時にCPU数とメインworkspaceのPID registryから同一性を確認できた `review-job` 数を取得し、`max(minimum, CPU数 - cpuReserve - review-job数 * reviewJobCost)` でテスト並列数を決める。どちらかの入力を読めない場合は宣言された下限で実行し、並列数・CPU数・review-job数・取得できなかった入力を層別成果物へ残す。PR worktree上の実行もメインworkspaceのreview-job数を参照する。slow結果は同じworktreeの単一層別成果物へ保存され、完了時にテスト申告コメントを更新する。同一コミットの既存申告があれば、full層・lint/typecheckなど slow の成果物に無い記録を残して層単位で合成し（`結果` 行は全層から再計算）、層のどれかが fail なら RED になる。`SLOW_TEST_RESULT` とテスト申告の層別結果にも計算値と入力状態を含める。対象HEADの照合不能、worktree不在、子プロセス異常終了は `unavailable` として実行ログ識別子を残し、自動再試行・自動診断を行わない。

```sh
node "{{SCRIPTS_PATH}}/poll-pr-monitor.js" --plugin-monitor --workspace "$WORKSPACE"
```

上のコマンドはpluginが固定で起動する実体であり、通常の対話型セッションで手動実行しない。

Review Managerの完了、通常経路のslow層結果、GitHub checks、テスト申告を利用可能なHEADと照合する。通知が揃わない場合は受け取った事実を保持し、自動再実行・自動診断を行わない。必要な結果を確認するまでコーダーのrollbackやworktree削除へ進まない。軽量PRではslow層とGitHub checksを待たない。

レビュー指摘が届いたら7-[3/6]、findingsが0件なら7-[3/6]を理由付きでスキップする。転送済みBLOCKER/MAJORの修正pushがあれば7-[4/6]を完了してから7-[5/6]へ進む。PRが閉じられた場合は通知表に従い、監視が新しいPR検出へ戻ったことを確認してPR_DETECTEDを待つ。起動シグナルの欠落やReview Managerのクラッシュは7-[2/6]で扱う。

#### 7-[2/6] PR監視・Review Managerの再起動【任意】

plugin monitorまたはその子 `poll-pr.js` が落ちた場合の確認・targetの再設定、Review Managerが起動しなかった／失敗した場合の再起動は、いずれも `{{SHARED_SKILLS_PATH}}/gh-maestro-orchestrator/monitor-recovery.md` の「PR監視・Review Managerの再起動」を参照する。異常を人間へ報告するときは `工程7-[2/6]` と名乗る。**再レビューが不要な場合は `activate-pr-monitor.js` に `--no-review-manager` を渡すこと**（付け忘れると検出のたびにレビューが蒸し返されquotaを浪費する）。
理由と経緯: docs/adr/0046-review-manager-resume-requires-explicit-flag.md

#### 7-[3/6] コメントトリアージ【任意】

Review Manager の findings が1件以上あるときだけ行う。0件のPRではトリアージは発生せず、7-[5/6]の提示の冒頭で `工程7-[3/6]（任意）をスキップ：findings 0件` と名乗る。

PRに新しいレビューコメントが届くたびに、orchestratorは指摘を評価するところまでを行う。`{{SHARED_SKILLS_PATH}}/gh-maestro-orchestrator/triage.md` を開き、そこに従って実害度スコア／対応コストの付与・人間への提示・回答に従った実行を行う。提示は `工程7-[3/6]` と名乗り、「人間への発言の規範」に従う。**実際にコーダーに修正依頼する／無視する／保留Issueに積むという実行アクションは、観点やスコアの値に関わらず、必ず人間の明示的な決定を経てから行う。** 観点・実害度・対応コストがどうであれ、人間の確認を省略してよい経路は存在しない。同じBLOCKERが2回連続して届くスパイラルの提示もここで行う。

回答に従って修正を依頼したら7-[1/6]の監視へ戻る。全指摘の処理後、該当する修正push後の事実確認があれば7-[4/6]を行い、その後7-[5/6]へ進む。該当しなければ7-[4/6]を理由付きでスキップする。

#### 7-[4/6] 修正push後の事実確認【必須】

転送済みBLOCKER/MAJORへの修正を含むPR_PUSHが届いたときに行う。元の指摘と修正pushのHEADを指定し、既存のexplorerへ再現条件が解消したかを事実確認させる。調査前にexplorer自身が対象PRのbranch/commitをfetchし、対象HEADをcheckoutしたことを確認する。調査結果に推測を混ぜず、対象SHA・再現手順・結果を受け取り、結果が確認できるまでその指摘を未解消として扱う。別の指摘修正pushにも同様に確認する。

該当する転送済みBLOCKER/MAJORが無い場合は、工程7-[4/6]（必須項目、条件該当なし）を理由付きでスキップして7-[5/6]へ進む。

#### 7-[5/6] マージ判断の依頼【必須】

`REVIEW_MANAGER_STARTED` は起動シグナルで、レビュー完了ではない。人間にマージ候補として提示してよいのは次の条件を満たすときだけである。提示は `工程7-[5/6]` と名乗り、7-[1/6]の監視結果（Review Manager、テスト申告、CI checks）と、7-[3/6]を行ったかどうかを載せる。マージ判断の問いは「人間への発言の規範」に従う。

- Review Manager 完了（`PR_REVIEW:...Posted inline findings: N` 到着 or `records/pr/<PR>/review/manager.json` 生成）
- 完了 findings を triage 済みで BLOCKER ゼロ（findings は 1 問題×3 観点で重複するのでクラスタで triage。転送済み BLOCKER/MAJOR は、修正 push に対する explorer の事実確認が完了するまで未解消として扱う）
- **テスト申告状態の確認と事実提示（Issue #209）**:
  - `node "{{SCRIPTS_PATH}}/query-test-status.js" --pr <PR>` を実行し、成功時に返るJSON 1行をテスト申告状態の正本として確認する。このコマンドは現在のPRコメントとHEADをGitHubから取得するため、`poll-reviews.js` の内部状態ファイルや「新しいコメントがあるか」の推測を使わない。
  - JSONの `status`（`GREEN`/`RED`/`STALE`/`NONE`）と、存在する `declaredSha`・`headSha`・`fail`・`pass`・`provenance`・`scope`・`lint`、`typecheck`、層別結果の `failedTests`・`otherFailedCount` を**解釈を加えずそのまま事実として記載**する。申告コメントの層行の直下にある「失敗詳細」行（失敗したテスト名・場所・エラー・期待値と実際値、省略された件数と実行記録の名前）も、同じく解釈を加えず原文のまま載せる。これは slow 層の失敗だけに付き、件数は `failedTests` の上限5件までに揃う。slow層に `dynamicConcurrency` がある場合は、その `value`・`cpuCount`・`reviewJobCount`・`status`・`unavailableInputs` も確認して伝える。`GREEN` は申告あり・SHA一致・fail 0、`RED` は申告あり・SHA一致・fail > 0、`STALE` はSHA不一致、`NONE` は申告なしまたは照合不能を表す。`lint.status` は従来どおり `complete`（`outcome=pass` または `findings` と `findingCount`）、`unavailable`、`missing` のいずれか。`typecheck.status` は `complete`（`outcome=pass/fail` と `exitCode`）、`unavailable`、`undefined`、`missing` のいずれか。いずれも `unavailable`/`missing` を状態のない GREEN と読み替えてはならない。lint の指摘と型チェック結果は commit・push・PR作成・merge の機械停止条件ではなく、止めるかどうかは orchestrator と人間が判断する。`provenance` が `unknown`、または `scope` が `unknown` の場合も、その値を変更せず記載する。
  - コマンドが非0終了した場合は、状態を `NONE` と取り違えず、テスト申告状態を照会できなかった事実を提示する。
- **GitHub CI checksの確認と事実提示**:
  - 通常経路PRでは `node "{{SCRIPTS_PATH}}/query-pr-checks.js" --pr <PR> --repo $REPO` を実行し、現在のHEADに紐づくcheck runsとcommit statusesを照会する。成功時はJSONの `headSha` と各checkの名前・状態・詳細URLをテスト申告と並べて提示する。軽量PRではGitHub CI checksを照会・通知しない。
  - `hasChecks=false` はチェックなし、`hasRunning=true` は実行中、`allCompleted=true` は全件完了を表す。`hasRunning=true` の間は merge 候補として提示せず、`CI_CHECKS_COMPLETE` または `CI_CHECK_FAILED` を受けてから結果を提示する。`hasChecks=false`（`CI_CHECKS_EMPTY`）は待たずに提示する。
  - コマンドが非0終了した場合は、CI状態を取得できなかった事実を提示する。チェックなし・成功として扱わない。
  - CI失敗と今回の変更との関連性を推測したり、「無関係」等の独自解釈を加えたりしない。CIの状態は機械的なマージ条件ではなく、止めるかどうかの最終判断は人間に委ねる。
  - **「無関係なテスト失敗だから」「今回は影響ないから」といった関係有無の判断や独自解釈を orchestrator が挟むことは禁止**。申告された事実（対象コミットSHA、fail件数、pass件数、失敗したテスト名と超過件数）をそのまま伝える。マージするかどうかの最終判断は人間に委ねる。
  - devの健全性確認やテスト障害の調査でslow層を全件実行する場合は、`node "{{SCRIPTS_PATH}}/run-slow-tests.js" --workspace $WORKSPACE` を使う。対象指定なしで宣言済みslow層を実行し、結果は通常のテスト成果物と同じruntime rootへ保存する。slow層に `dynamicConcurrency` が宣言されていれば、起動時の並列数と計算入力も記録される。`npm run test:slow` はコーダー経路のため、この用途には使わない。

#### 7-[6/6] 誤ってマージしてしまった場合の対処【任意】

人間から「マージを取り消したい」（レビュー未完了のまま早くマージされた等）と言われた場合は、`工程7-[6/6]` と名乗り、「人間への発言の規範」に従って対応内容を確認する。

- まず**revertが本当に必要か**を切り分ける。実装自体に問題があるのではなく、レビュー指摘への対応が終わる前に早くマージされただけなら、revertせずに残りの指摘対応を軽量PR経路の追いPRとして提出する方が安全（コンフリクトが原理的に発生しない）。
- 実装自体を一旦取り下げたい等、revertが本当に必要な場合は、タイトルだけのアンカーIssueを作成し、BASE_BRANCHからrevert用ブランチを切る。`git revert -m 1 <mergeCommit> --no-edit` はそのブランチ上で実行し、commit・push・PR作成後に `activate-pr-monitor.js --no-review-manager` だけを指定して監視する。revert用PRは軽量PRではなく、Review Managerを起動しない場合もslow層とGitHub CI checksの照会を行う。軽量PR用の `--no-review-events` は付けず、監視targetの設定は `{{SHARED_SKILLS_PATH}}/gh-maestro-orchestrator/monitor-recovery.md` の手順に従う。BASE_BRANCHへrevertコミットを直接追加してはならない。**このとき、元になった作業ブランチをそのまま延長させて指摘対応や再提出をさせてはならない。** そのブランチはrevertされたコミットの子孫であり続けるため、BASE_BRANCH側の「削除」とブランチ側の「追記」が同じファイルで必ず衝突する。revert後に作業を続けさせる場合は、revert後のBASE_BRANCHから新しくブランチを切って必要な差分を再適用させること。
- どうしても元のブランチをmerge/rebaseで復元させる場合、**revert後に一切触っていない新規追加ファイルは、コンフリクト一覧に出ないまま3-way mergeが無言で「削除」を採用することがある**（共通祖先＝revert前のマージ元コミット、BASE_BRANCH側＝削除、ブランチ側＝無変更、という組み合わせで自動的に削除が選ばれるため）。復元後はコーダーに`git diff <revert前の直前コミット> -- <変更ファイル一覧>`で無差分を確認させてからcommitさせること。

# GitHub Comment Message Bus 移行計画

策定日: 2026-07-07
状態: **承認済み計画**（本ドキュメントが正。`docs/server-plan.md` の Filesystem Message Queue 計画を全面的に置き換える）
対象読者: 実装を担当する coder / senior-coder エージェント。**本計画書に書かれていない設計判断を独自に行わないこと。** 不明点は orchestrator に質問する。

---

## 1. 目的と背景

orchestrator / worker 間のメッセージ配送を、ファイルシステムキュー（`.gh-maestro/queue/`）から **GitHub Issue コメント**に移行する。

### なぜ移行するか

- FSキュー本体（Maildirパターン）は安定したが、その周辺の**通知レイヤー**（detached 常駐プロセス: queue-poller / poll-and-notify、WezTerm 入力注入: pane-notify / send-enter）が、プロセスリーク・孤児化・二重起動・黒い窓など Windows 固有の障害を繰り返し起こし、開発時間を浪費した。直近30コミットの約半分がこの層の修正である。
- gh-maestro の本来の目標は「GitHub エコシステムに乗り、Issue / PR に記録が確実に残り、後からプロジェクトの歴史を紐解ける」こと。メッセージを Issue コメントにすれば、通信そのものが恒久的な記録になる。
- ワーカーのタスクは数分〜数十分単位であり、メッセージ配送に秒単位の低レイテンシは不要。30秒程度のポーリング遅延はノイズである。

### 移行後の世界

- **メッセージの真実は GitHub 上の Issue コメント。** ローカルには「どこまで読んだか」のカーソルだけを持つ（消えても再通知されるだけで、メッセージは失われない）。
- **detached 常駐プロセスは 0 個。** すべてのポーリングはエージェント自身のターン内で blocking 実行される（`poll-reviews.js` / `poll-inbox.js` で実証済みのパターン）。
- **WezTerm は起動基盤としてのみ使う**（ペイン作成・初期プロンプト投入）。通知のための入力注入は行わない。
- **人間の主要な読み面は orchestrator ペイン。** orchestrator が新着を要約して人間に提示する。生の記録は GitHub にあり、人間は好みのツール（gh-dash 等）で自由に読める。

---

## 2. 設計原則（実装中に迷ったらここに戻る）

1. **detached / unref なプロセスを新設しない。** ポーリングはすべて呼び出し元エージェントのターン内で blocking 実行する。
2. **npm 依存ゼロを維持。** Node 標準ライブラリ + `gh` CLI のみ。
3. **GitHub が真実、ローカルは使い捨てカーシー（cursor）。** ローカル状態ファイルの破損・消失は「再通知が起きる」以上の被害を生まない設計にする。
4. **ack 機構は作らない。** メッセージへの応答は「返信コメント」で表現する。無応答はタイムアウトでエスカレートする（現行の「PR 10分未検出で確認」ルールと同型）。
5. **gh コマンドへのユーザー由来値の受け渡しは注入安全に。** コメント本文は必ず `--body-file -`（stdin）経由。`.claude/rules/git-arg-injection.md` は gh にも適用する。
6. **既存の命名・パターンを踏襲する**（`--help` 必須 = `.claude/rules/skill-asset-help.md`、`parseFlags` / `resolveWorkspace` の再利用、テストでの実プロセス spawn 禁止 = `.claude/rules/test-process-spawn-safety.md`）。

---

## 3. アーキテクチャ

### 3.1 アンカー Issue

すべてのワーカーは **GitHub Issue をアンカー**として持つ。メッセージはアンカー Issue のコメントとして送受信される。

| ワーカー | アンカー |
| --- | --- |
| coder / senior-coder | 実装対象の Issue（現行どおり） |
| investigator | 調査対象のバグ Issue（既存があればそれ。なければ orchestrator が起草・作成する） |
| explorer | 調査の発端となった Issue（あればそれ。なければ orchestrator が `maestro:task` ラベル付きの軽量 Issue を作成する） |

これに伴い `spawn-worker.js` の `--issue` は**全ワーカーで必須**になる（現行は省略可）。orchestrator は spawn 前に必ずアンカー Issue を確保する。

### 3.2 メッセージ形式

メッセージ = アンカー Issue への1コメント。**1行目がマーカー、2行目以降が本文。**

```
<!-- gh-maestro {"v":1,"to":"issue-123-implement","from":"orchestrator"} -->
命名改善: src/auth.go:42 — processData → normalizeSSN に変更してください（PR #12 のレビュー指摘より）
```

- マーカーは HTML コメントなので、GitHub の Web UI ではほぼ不可視（本文だけが読める）。
- マーカー内は 1行の JSON。フィールドは `v`（スキーマバージョン、固定値 `1`）、`to`（宛先: worker 名または `"orchestrator"`）、`from`（送信者名）。
- 判定正規表現（受信側で使用）: `/^<!--\s*gh-maestro\s+(\{.*\})\s*-->/` にマッチした1行目の JSON を parse し、`to` が自分と一致するものだけを新着として扱う。JSON parse に失敗したコメント・マーカーの無いコメント（人間や bot の通常コメント）は**黙って無視**する。
- メッセージ ID は不要。GitHub のコメント ID（数値）がそのまま一意な ID になる。

### 3.3 受信（ポーリング）と既読状態（Issue #207 改訂）

- **既読の正本は「明示的に既読化されたコメントIDの集合」**であり、`.gh-maestro/msg-state/<self>.json`（v2スキーマ）に永続化する:

```json
{
  "schemaVersion": 2,
  "initialized": true,
  "generation": "reset-...（初期化時に払い出す操作ID）",
  "readByIssue": {
    "207": [5137395874, 5137433600, 5137437793]
  },
  "sinceByIssue": {
    "207": "2026-07-07T12:00:00Z"
  }
}
```

- `readByIssue`（正本）: Issue ごとの既読コメントID。ID は GitHub 全体で一意のため、別 Issue の ID が混入しても照合に影響しない（再登録・冗長は無害）。**件数上限で切り捨てない**。
- `sinceByIssue`（取得最適化カーソル）: 各 Issue の「最後に処理したコメントの直近 created_at」。**既読判定には一切使わない**。受信はこのカーソルの**1秒前**から `gh api .../comments?since=...` で差分取得する（GitHub の since は排他的 `created_at > since` とみなし、境界秒の取りこぼしを防ぐ安全マージン。新着コメントは必ずウォーターマーク以上の created_at を持つため、1秒前からなら全件を確実に含める）。持ち越し候補がある Issue はカーソルを進めない（since ベース取得から持ち越しが消えない）。取得失敗時もカーソルを進めず、次サイクルで同じ範囲を再取得する（フェイルクローズ。黙って古いコメントを見逃さない）。
- 通常走査は各コメントの ID を `readByIssue` と照合し、未記録 ID だけを新着候補にする。通知した ID は**通知後に**既読記録する（出力→記録の順で、クラッシュ時は重複通知側に倒れる）。マーカーなし・自分宛てでない・`created_at` 欠落など通知しないことが明示されている ID も「なぜ通知しないか」を分類した上で既読記録する（毎走査の再処理を避ける）。
- 既読状態の更新はすべて `scripts/shared/read-state.js` 経由。**ロック取得 → 最新状態の再読込 → 集合和 → 原子的保存（tmp+rename）**。複数プロセス（msg-poll / spawn-worker / reset）が同じ状態を排他更新できる。
- **orchestrator の state が欠落・破損・旧形式（v1）・未初期化の場合、空状態を暗黙作成せず走査を停止し「reset-session.js での明示初期化が必要」と報告する**（大量通知と暗黙の握り潰しの両方を避ける）。復旧は reset（既読ベースライン再構築）のみ。
- **ワーカー生成時**（`spawn-worker.js`）: プロセス起動前に、対象 Issue の既存コメントIDスナップショットを orchestrator の既読集合へ追加する（ベースライン）。**ベースラインが永続化されるまでワーカーを起動しない**。ワーカー自身の計画コメント投稿は起動後なのでスナップショットに含まれず、必ず新着として通知される。
- **状態リセット時**（`reset-session.js`）: `msg-state/` の単純削除をやめ、wipe 前の `workers.json` の管理対象 Issue について既読ベースラインを再構築する（generation 付き initialized 状態）。取得・保存の一部が失敗した場合は新状態を書き込まず、空状態でポーラーを再開しない。
- `<self>` はファイルパス要素になるため、**`path.join` の前に必ず path-safety 検証を通す**（旧queue-poller時代の`queue-path-safety`ルール（削除済み、後述§下表）と同型。検証関数は §4.1 の `shared/validate.js` を使う）。

### 3.4 送信

- `gh issue comment <N> --body-file -` で stdin からマーカー + 本文を投稿する。exit 0 = 投稿成功（コメント URL が stdout に返る）。
- enqueue と違い「lazy-start」「配送保証」の概念が存在しない。**投稿成功 = GitHub 上に永続化された = 配送完了。** 相手はいずれポーリングで読む。

### 3.5 PR 検出

- `poll-pr.js`（既存・GitHub ベース）は**存続**する。
- 変更点: detached な `poll-and-notify.js` 経由で起動するのをやめ、**orchestrator が自分のターン内 Monitor で `poll-pr.js` を直接実行**する（レビューの `poll-reviews.js` と同じ形）。spawn-worker.js は notifier を起動しない。

### 3.6 通信フロー全体像（移行後）

```
orchestrator                            worker (coder等)
  |                                        |
  |-- spawn-worker.js --issue N ---------->| (WezTermペイン起動・初期プロンプト投入: 現行どおり)
  |                                        |
  |-- msg-send.js <worker> "<指示>" ------>|  Issue N にコメント投稿
  |                                        |-- msg-poll.js <worker> --issue N (ターン内Monitor)
  |                                        |     → NEW_MESSAGE:<commentId>
  |                                        |-- msg-read.js <commentId> で本文取得 → 処理
  |<-- msg-send.js orchestrator "<報告>" --|  Issue N にコメント投稿
  |-- msg-poll.js orchestrator (Monitor)   |
  |     → NEW_MESSAGE:<issue>:<commentId>  |
  |-- poll-pr.js <N> (Monitor) ------------| PR検出（現行ロジック、起動方法だけ変更）
  |-- poll-reviews.js <PR> (Monitor) ------| レビュー監視（現行どおり・変更なし）
```

---

## 4. 新規スクリプト仕様

すべて `scripts/` 直下。すべて `--help` / `-h` 実装必須（usage 表示で exit 0、引数不足は usage を stderr に出して exit 1）。workspace 解決は `shared/workspace.js` の `resolveWorkspace` / `parseFlags` を再利用する。repo 解決は `gh repo view --json nameWithOwner -q .nameWithOwner`（poll-pr.js と同じ方法）。

### 4.1 `scripts/shared/validate.js`（新規・共有ヘルパ）

`queue.js` の `validateField`（親参照 `..`・パス区切り・制御文字の拒否、空文字拒否）を**移設**する。queue.js 削除後も path-safety 検証を共有できるようにするのが目的。移設時に queue.js 側は shared/validate.js を require する形に書き換え（Phase 3 で queue.js ごと消えるまでの互換維持）。

### 4.2 `scripts/msg-send.js`

```
Usage: node msg-send.js <recipient> [--issue <N>] [--workspace <path>] "<本文>"
```

- `<recipient>`: worker 名または `orchestrator`。
- `--issue` 省略時: `<recipient>` が worker 名なら `.gh-maestro/workers.json` の該当エントリから `issue` を解決する。解決できなければ exit 1（フェイルクローズ。`.claude/rules/fail-closed-safety-guards.md`）。`orchestrator` 宛の場合は送信者が自分のアンカー Issue を知っているため `--issue`（または env `ISSUE`）必須。
- 動作: マーカー行（`from` は env `WORKER_NAME`、無ければ `orchestrator`）+ 空行なしで本文を連結し、`gh issue comment <N> --body-file -` の stdin に渡す。
- 出力: 成功時、投稿されたコメント URL を stdout に1行。exit 0。gh が非0で終了したら stderr をそのまま流して exit 1。**リトライ・lazy-start は実装しない。**
- **GraphQLフォールバック（2026-07-17改訂）**: REST APIが5xx/タイムアウト等サーバ・ネットワーク起因で失敗した場合のみ、`shared/gh-fallback.js` の `graphqlAddComment` 経由で `gh api graphql` によるコメント投稿にフォールバックする。4xx等のクライアントエラー（存在しない Issue・権限なし等）はフォールバックせずそのままエラー返却する（同じ理由で失敗するため無駄な二度手間を避ける）。改訂理由は §8 参照。

### 4.3 `scripts/msg-poll.js`

```
Usage: node msg-poll.js <self> [--issue <N>] [--workspace <path>] [--interval <sec>] [--once]
```

- **worker モード**（`<self>` が worker 名）: `--issue <N>` 必須。Issue N のコメントを `--interval`（既定 **20秒**）ごとにポーリングし、マーカーの `to` が `<self>` に一致する新着を検出する。
- **orchestrator モード**（`<self>` が `orchestrator`）: `--issue` 不要。ポーリングごとに `.gh-maestro/workers.json` を読み直し、登録中の全ワーカーの `issue`（重複排除）を対象に `to == "orchestrator"` の新着を検出する。workers.json が無い・空のサイクルは何もせず継続する。
- 出力プロトコル（stdout、1行1メッセージ）:
  - worker モード: `NEW_MESSAGE:<commentId>`
  - orchestrator モード: `NEW_MESSAGE:<issue>:<commentId>`
- カーソルは §3.3 の `.gh-maestro/msg-state/<self>.json`。起動時に読み、通知のたびに更新して書く（tmp に書いて rename、`shared/` にヘルパを置いてよい）。
- gh の呼び出しが失敗したサイクル（ネットワーク断・rate limit 等）は stderr に1行出して**スキップし、次のサイクルへ継続**する。プロセスは死なない。
- **GraphQLフォールバック（2026-07-17改訂）**: RESTがサーバ・ネットワーク起因で失敗した場合、`shared/gh-fallback.js` の `graphqlListComments` にフォールバックする。GraphQLには REST の `since` 相当のサーバ側フィルタが無いため、直近100件を取得しクライアント側で `createdAt > since` を判定する。**制約**: 1ポーリング間隔中に自分宛ての未読が100件を超える異常事態では取りこぼす可能性がある。フォールバックは短期障害時のみの利用と割り切る。`databaseId` フィールドがREST版の数値コメントIDと同一なので、`NEW_MESSAGE:<id>` の出力プロトコルはフォールバック使用の有無に関わらず変わらない。
- `--once`: 1回スキャンして exit 0（テスト・agy 系エージェント用）。カーソルは永続化されるため、`--once` の繰り返し実行でも二重通知しない（poll-inbox.js の in-memory Set と違い、ここが改善点）。
- SIGINT / SIGTERM でクリーンに exit 0（poll-inbox.js の cleanup と同型）。
- **detached 起動・子プロセス spawn・WezTerm 通知は一切行わない。**

### 4.4 `scripts/msg-read.js`

```
Usage: node msg-read.js <commentId> [--workspace <path>] [--issue <N>]
```

- `gh api repos/{repo}/issues/comments/<commentId> -q .body` を実行し、**マーカー行を取り除いた本文**を stdout に出力する。exit 0。
- 存在しない commentId は gh のエラーを stderr に流して exit 1。
- 目的: エージェントが repo 解決や jq クエリを手書きせず、1コマンドで本文を読めるようにする。
- **GraphQLフォールバック（2026-07-17改訂）**: RESTがサーバ・ネットワーク起因で失敗した場合、`shared/gh-fallback.js` の `graphqlCommentBody` にフォールバックする。GraphQLはコメントの `databaseId`（REST数値ID）から直接1件を引く root クエリを持たないため、**任意の `--issue <N>` フラグ**を追加した。フォールバック発動時にissue番号が分かれば、そのissueの直近100件からdatabaseId一致するコメントを検索して本文を返す。`--issue` 省略時にフォールバックが必要になった場合はエラーで諦める。orchestratorは`NEW_MESSAGE:<issue>:<commentId>`から、workerは自分のアンカーissue（env `ISSUE`）からissue番号を得られるため、実運用では省略されない想定。

### 4.5 レート制限の見積り（実装判断の根拠）

認証済み `gh` の REST は 5,000 req/h。ワーカー3 + orchestrator（Issue 3件監視）が全員 20秒間隔でも `(3×1 + 1×3) × 180 = 約1,100 req/h` で余裕がある。`since` パラメータでペイロードも最小化される。ETag / 条件付きリクエストによる最適化（304 はレート制限を消費しない）は**やらない**（現時点で不要な複雑さ。将来ワーカー数が増えたときの選択肢としてここに記録するのみ）。

---

## 5. 既存コードの変更

### 5.0 `scripts/shared/gh-fallback.js`（新規・2026-07-17追加）

REST APIがサーバ・ネットワーク起因（5xx/タイムアウト等）で失敗した場合に、`gh api graphql` による等価操作へフォールバックする共有ロジック。`isRetryableGhFailure(result)`（フォールバック対象か判定）、`graphqlAddComment`（コメント投稿）、`graphqlListComments`（コメント一覧、`since`はクライアント側フィルタ）、`graphqlCommentBody`（`--issue`必須のコメント本文取得）、`graphqlCreateIssue`（Issue作成）を提供する。`msg-send.js` / `msg-poll.js` / `msg-read.js` / `create-issue.js` から利用される。テスト注入用に `_setGraphqlExec` を公開し、ユニットテストは実 `gh` を起動しない。詳細・改訂理由は §8 参照。

### 5.1 `scripts/spawn-worker.js`

- `--issue` を**必須化**（無ければ usage を出して exit 1）。ワーカー名の `task-<description>` 形式は廃止し、常に `issue-<N>-<description>`。
- workers.json エントリに `issue: <N>` を**必ず記録**する（現行スキーマ `{paneId, agentId}` に追加）。
- **poll-and-notify.js の detached 起動を削除**（L376 付近のブロックごと）。`notifierPid` の記録も削除。
- 初期プロンプト（contextLines）: `ISSUE=<N>` は必須化により常に入る。`TASK=` 行は廃止（タスク内容は Issue 本文が真実）。
- WezTerm ペイン作成・worktree 作成・プロンプト投入は**変更しない**。

### 5.2 `scripts/remove-worker.js` / `scripts/reset-session.js`

- notifier（poll-and-notify）kill 処理を削除。
- inbox purge（`purgeInbox`）呼び出しを削除し、代わりに `.gh-maestro/msg-state/<worker>.json` を削除する（ベストエフォート、ENOENT は成功扱い）。
- queue-poller の kill / poller.json 掃除を削除（Phase 3 時点）。

### 5.3 SKILL.md / agents.yaml（`.claude/rules/worker-flow-audit.md` により、5.1 と同一 PR で更新し `/audit-worker-skills` を実行すること）

- `skills/gh-maestro-orchestrator/SKILL.md`:
  - `queue-send.js` → `msg-send.js <worker> "<内容>"` に全置換（--issue は workers.json から自動解決されるため書かない）。
  - inbox 監視（Monitor + poll-inbox.js orchestrator）→ `msg-poll.js orchestrator --workspace $WORKSPACE` に変更。`NEW_MESSAGE:<issue>:<commentId>` を受けたら `msg-read.js <commentId>` で本文を読む。ack 手順は削除。
  - coder spawn 後の PR 検出: 「spawn-worker が notifier を起動する」記述を「orchestrator 自身が Monitor で `poll-pr.js <N>` を起動する」に変更。
  - explorer / investigator 起動前に「アンカー Issue を確保する」手順を追加（§3.1 の表のとおり）。
- `skills/gh-maestro-base|coder|senior-coder|explorer|investigator/SKILL.md`:
  - `send-pane.js orchestrator ... "<内容>"` → `msg-send.js orchestrator --issue $ISSUE "<内容>"` に全置換。
  - inbox 監視・`queue-ack.js` 手順 → `msg-poll.js $WORKER_NAME --issue $ISSUE` + `msg-read.js` に変更。ack 手順は削除し、「指示を処理したら必ず msg-send.js で結果を返信する」を明記する。
- `skills/agents.yaml`: `INBOX_POLL_MECHANISM`（claude / agy / その他全エージェント分）を msg-poll ベースに書き換える。agy 系は `--once` をループ実行する現行パターンを踏襲（カーソル永続化により --once でも二重通知しない旨を反映）。
- 置換の完全性確認: `.claude/rules/`（feedback-exhaustive-grep）に従い、`queue-send|queue-ack|poll-inbox|send-pane|pane-notify|poll-and-notify|queue-poller` を**リポジトリ全体で grep** し、参照ゼロを確認してから完了とする（Phase 3 完了条件）。

---

## 6. 削除対象（Phase 3 で実施）

| 削除 | 理由 |
| --- | --- |
| `scripts/queue.js` `queue-send.js` `queue-ack.js` `queue-status.js` `queue-prune.js` `queue-poller.js` | FSキュー本体・付属CLI |
| `scripts/poll-inbox.js` | msg-poll.js に置換 |
| `scripts/poll-and-notify.js` | orchestrator が poll-pr.js を直接 Monitor 実行 |
| `scripts/send-pane.js` `scripts/pane-notify.js` `scripts/send-enter.js` `scripts/pane-lock.js` | WezTerm 通知注入レイヤー全廃 |
| 上記のテストファイル | 対応するテスト |
| `.claude/rules/`配下の`queue-concurrency`・`queue-path-safety`ルール（削除済み） | 対象コード消滅。ただし path-safety の教訓は shared/validate.js の docコメントと本計画 §3.3 に引き継ぐ |
| `docs/server-plan.md` | 冒頭に「superseded by github-comm-plan.md」を追記（削除はしない。歴史として残す） |

**削除しない**もの: `poll-pr.js`（存続・起動方法のみ変更）、`poll-reviews.js`（無変更）、`wezterm-cli.js` / `send-pane` 以外のペイン起動系（spawn-worker が使用）、`kill-tree.js`（remove-worker のペイン kill で使用が残るか確認し、未使用になった場合のみ削除）。

`.claude/rules/test-process-spawn-safety.md` は**残す**が、queue-poller 固有の記述（poller.json の pid:0 等）を削除し、「detached プロセスをそもそも作らない」原則を追記する。

---

## 7. 実装フェーズ

各 Phase = 1 Issue = 1 PR。Phase 1〜2 の間、既存キューは無傷のまま並存する（ロールバック = PR revert で済む）。

### Phase 1: 新規スクリプト追加（既存コード無変更）

- `shared/validate.js`（queue.js からの移設）、`msg-send.js`、`msg-poll.js`、`msg-read.js` とテストを追加。
- テスト方針: **gh を実行しない。** gh 呼び出しは関数として注入可能にし（`queue-poller` テストのモック注入と同じパターン）、テストはモックで応答を返す。カーソルの永続化・マーカー解析・`to` フィルタ・破損 state ファイル回復・`<self>` の path-safety を単体テストで網羅する。実プロセス spawn 0 個（既存 rule 準拠）。
- 完了条件: `npm test` 緑 + 手動で実 Issue に対する `msg-send.js` → `msg-poll.js --once` → `msg-read.js` の一往復を実行して確認（`.claude/rules/agent-test-before-commit.md`: --help だけでは不十分）。

### Phase 2: 切り替え（spawn-worker + skills + agents.yaml）

- §5.1〜5.3 の変更をすべて実施。`/audit-worker-skills` を実行。
- この時点で queue-* / poll-inbox / send-pane はコード上は残るが、どの SKILL.md からも参照されなくなる。
- 完了条件: `npm test` 緑 + dev マージ後に `node scripts/install.js`（**dev から実行**）+ 実ワーカー1体で「spawn → 指示送信 → ワーカー返信 → orchestrator 受信 → PR 検出」の一巡を実際に回す。

### Phase 3: 撤去

- §6 の削除をすべて実施。§5.3 末尾の全文 grep で参照ゼロを確認。
- 完了条件: `npm test` 緑 + grep ゼロ + `node --test` 実行後に孤児 node プロセス 0 個（rule 記載の確認コマンド）。

### Phase 4: 運用検証

- 実タスク2〜3件を新方式で完走させ、問題があれば反省会で rules 化する。install.js を dev から再実行して配布を最新化。

---

## 8. 既知のリスクと割り切り

- **ネットワーク依存（2026-07-17改訂）**: 当初は「GitHub断でメッセージ送受信が止まる。割り切る（ghは既にシステム全体のハード依存であり、PR/Issue操作が止まる時点でどのみち作業は止まる）」としていた。この割り切りは「RESTが死ねばGraphQLも同時に死ぬ」という暗黙の前提に基づいていたが、2026-07-17に実際に発生したREST API障害（Degraded Performance）ではGraphQL APIとGit Operationsは無傷だった（`gh api graphql`での実地検証済み）。前提が崩れたため、メッセージ配送（`msg-send.js`/`msg-poll.js`/`msg-read.js`）とIssue作成（`create-issue.js`）については `shared/gh-fallback.js` によるGraphQLフォールバックを導入し、REST劣化時も通信を継続できるようにする（§5.0参照）。**このフォールバックのスコープはコメント送受信とIssue作成に限定する。** PRレビュー投稿・PR検出等の他のgh依存操作（`post-review.js`/`review-publisher.js`/`poll-pr.js`）はフォールバック対象外のまま据え置く（スコープ外。将来必要になれば別途検討）。msg-pollはエラーサイクルをスキップして継続するため、フォールバックも失敗した場合は復旧後に自動的に追いつく。
- **Issue のチャター増加**: 指示・報告がコメントとして残る。これは**欠点ではなく本計画の目的**（歴史の記録）。ただし「着手しました」等の無内容な報告は現行 SKILL.md どおり禁止を維持する。
- **秘匿情報**: コメントは repo の可視性に従う。SKILL.md に「トークン・認証情報・個人情報をメッセージ本文に含めない」を明記する（FSキュー時代には無かった注意点）。
- **同一 Issue 上の複数ワーカー**: アンカー Issue が同一でも `to` フィルタで混信しない。カーソルは受信者ごとに独立。
- **レイテンシ**: 最悪 interval（20秒）+ gh 応答時間。タスク粒度に対して無視できる。

## 9. 意図的にやらないこと

- ack / delivered 状態管理（返信 + タイムアウトエスカレートで代替）
- ETag / 条件付きリクエスト最適化（§4.5 に将来の選択肢として記録済み）
- WezTerm への新着通知注入（人間の読み面は orchestrator ペイン。それ以上は人間が gh-dash 等を自己責任で使う）
- webhook / GitHub Actions ベースの push 通知（ローカルへの到達手段が結局ポーリングになる）
- FSキューとの互換レイヤー・二重書き込み（並存期間は「未参照のまま残る」だけ。ブリッジは作らない）

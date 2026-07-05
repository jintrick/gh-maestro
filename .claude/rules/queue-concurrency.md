---
paths:
  - "scripts/queue*.js"
  - "scripts/pane-notify.js"
  - "scripts/poll-and-notify.js"
---

# ファイルシステムキューの並行アクセス安全性

`.gh-maestro/queue/` は orchestrator / worker / poller が**同一ディレクトリを同時にアクセスする前提**（`docs/server-plan.md` 参照）。単一プロセス視点で書かないこと。以下を守る。

- **`fs.existsSync(x)` の結果に依存して直後に別の fs 操作をしない（TOCTOU）。** チェックと操作の間に別プロセスが状態を変える。`renameSync` / `readdirSync` / `unlinkSync` 等は `try/catch` で囲み、`ENOENT` は「別プロセスが先に処理した」＝多くの場合**成功扱いで吸収**する（例: ack の二重実行・並行実行はエラーにせず冪等に返す）。
- **走査系（`listPending` / `readdirSync` でディレクトリを列挙する処理）は、対象ディレクトリが消えても落ちない。** `readdirSync` を `try/catch` で囲み、`ENOENT` 時は空配列を返す。
- **「ベストエフォート」と銘打つ掃除系関数（`pruneAcked` 等）は、ループ内 fs 操作の例外を必ず握りつぶし、呼び出し元へ伝播させない。** 契約どおり途中で落ちても残りを掃除し続ける。
- **`EBUSY` / `EPERM`**（Windows のウイルススキャナによる一時ロック）は短間隔リトライで吸収する。恒久エラーとして即 throw しない。
- 書き込みは同一ボリュームの `tmp/` に書いてから `rename`（atomic）。inbox に不完全な JSON を見せない。

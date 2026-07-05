---
paths:
  - "scripts/queue*.js"
  - "scripts/pane-notify.js"
  - "scripts/poll-and-notify.js"
  - "scripts/send-pane.js"
  - "tests/queue-poller.test.js"
---

# ファイルシステムキューの並行アクセス安全性

`.gh-maestro/queue/` は orchestrator / worker / poller が**同一ディレクトリを同時にアクセスする前提**（`docs/server-plan.md` 参照）。単一プロセス視点で書かないこと。以下を守る。

- **`fs.existsSync(x)` の結果に依存して直後に別の fs 操作をしない（TOCTOU）。** チェックと操作の間に別プロセスが状態を変える。`renameSync` / `readdirSync` / `unlinkSync` 等は `try/catch` で囲み、`ENOENT` は「別プロセスが先に処理した」＝多くの場合**成功扱いで吸収**する（例: ack の二重実行・並行実行はエラーにせず冪等に返す）。
- **走査系（`listPending` / `readdirSync` でディレクトリを列挙する処理）は、対象ディレクトリが消えても落ちない。** `readdirSync` を `try/catch` で囲み、`ENOENT` 時は空配列を返す。
- **「ベストエフォート」と銘打つ掃除系関数（`pruneAcked` 等）は、ループ内 fs 操作の例外を必ず握りつぶし、呼び出し元へ伝播させない。** 契約どおり途中で落ちても残りを掃除し続ける。
- **`EBUSY` / `EPERM`**（Windows のウイルススキャナによる一時ロック）は短間隔リトライで吸収する。恒久エラーとして即 throw しない。
- 書き込みは同一ボリュームの `tmp/` に書いてから `rename`（atomic）。inbox に不完全な JSON を見せない。

## 配送の不変条件（enqueue ≠ 配送）

`enqueue` は inbox に置くだけで、宛先に届いたことを意味しない。配送は poller が担う。以下を守る。

- **enqueue するすべての経路は、enqueue 成功後に共有 lazy-start ヘルパで poller の生存を保証する。** poller 未起動のセッションでは inbox に置いたメッセージが誰にも通知されず埋もれる。`send-pane.js` / `queue-send.js` / `poll-and-notify.js` はいずれもこの責務を持つ（新たな enqueue 経路を足すときも同じ）。
- **poller の lazy-start は副作用であり、その失敗が enqueue の結果を汚してはならない。** lazy-start は独立した `try/catch` で囲み、起動に失敗しても enqueue 自体が成功していれば **exit 0（＝enqueue 成功）** を返す。起動失敗を「enqueue 失敗」と誤報すると、呼び出し元が重複再送する。
- **worker 宛ての通知文は ack 可能でなければならない。** 通知には ack 対象の `messageId`（と inbox ファイルパス）を必ず含める。`queue-ack.js <messageId>` を要求しておきながら messageId を示さない通知は、受信側が ack できず pending が滞留・再通知・エスカレートを繰り返す。
- **子プロセスの stdout を最後まで読み切ってから終了する処理は `'exit'` ではなく `'close'` イベントで行う。** `'exit'` はストリームの drain を保証せず、バッファ末尾（enqueue すべき最終行など）を取りこぼす。

## poller.json の `pid:0` の意味論（実装・テスト共通の罠）

`acquirePollerLease`（`queue-poller.js`）の lease 判定を、単純な「稼働中/不在」で読まないこと。

- **`pid:0` は「poller 不在」ではなく「placeholder（lazy-start が乗っ取ってよい）」を意味する。** `acquirePollerLease` は `!existing.pid || existing.pid === 0` を placeholder 判定に使い、fresh-heartbeat チェックを迂回して**実 poller を spawn する**。
- **稼働中 poller をテストで模擬するには、生きた非0 PID（例: `process.pid`）を使う。** `pid:0` ＋新鮮な heartbeat を書いても「poller 稼働中」の表現にはならず、逆に実 poller の spawn を引き起こしてテストが孤児プロセスをリークする（このリークは既存テストが pass していても race condition で潜伏する）。
- **テストが `poller.json` を直接書くときは、その pid 値が `acquirePollerLease` にどう解釈されるか（placeholder / fresh / stale）を必ず確認する。**

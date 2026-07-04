# Filesystem Message Queue 実装計画

策定日: 2026-07-05（HTTP message bus 案を全面改稿）
対象: `scripts/send-pane.js`, `scripts/message-file.js`, `scripts/poll-and-notify.js`, `scripts/spawn-worker.js`, `scripts/reset-session.js`, `skills/*/SKILL.md`, `.gh-maestro/queue`

## 目的

worker / orchestrator 間のメッセージ配送を WezTerm 入力注入から切り離し、ファイルシステム上のキューを唯一の真実にする。

WezTerm への send-text は「新着があることを知らせる通知」だけに使う。通知は失敗してもよく、何度でも再送できる冪等な操作に格下げする。配送の成否は ack だけで判定する。

## HTTP bus 案からの変更理由

前計画は file-backed queue の前段に HTTP サーバーを置く構成だった。しかし全参加者（orchestrator / worker / poller）は同一マシン・同一ファイルシステム上にいるため、HTTP 層は「サーバーのライフサイクル管理」「ポート・token 管理」「bus 不達という自作の障害モード」を追加するだけで、得るものがない。

キューをファイルシステムで直接表現すれば（Maildir パターン）:

- 送信 = atomic write。「bus が落ちている」状態が存在しないため、fallback 経路・`degraded` 状態・outbox replay が設計から消える。
- 冪等性 = ファイル名が `messageId` なので構造的に保証される。
- 通知側はどのみちポーリングであり（HTTP 案の sidecar も poll だった）、ローカルディレクトリの poll は HTTP poll から障害モードを引いたものになる。

## 設計原則

- キューの実体はディレクトリ。**メッセージの状態はファイルの置き場所で表現する**。状態フィールドの更新処理を作らない。
- 書き込みは同一ボリュームの `tmp/` に書いてから rename（atomic）。inbox に見えた時点でファイルは完成している。書きかけを読む競合は存在しない。
- `messageId` はファイル名。論理メッセージ単位で固定し、再送は同名ファイルへの冪等な上書きになる。
- send-text の成功を配送成功と扱わない。**ack だけが delivered の根拠**。
- npm 依存ゼロを維持する。Node 標準ライブラリのみ。
- worker は AI CLI であり、**ack を忘れる前提**で設計する。通知文に「処理済みなら ack のみせよ」を必ず含め、再通知による二重処理を防ぐ。

## ディレクトリ構成

```text
.gh-maestro/queue/
  tmp/                                  # 書き込みステージング（同一ボリューム必須）
  inbox/<recipient>/<messageId>.json    # 未ack = pending
  acked/<recipient>/<messageId>.json    # ack済み = delivered
  poller.json                           # poller の pid / heartbeat
```

`<recipient>` は worker 名または `orchestrator`。orchestrator も inbox を持ち、worker → orchestrator 方向（現在 `poll-and-notify.js` が send-pane で送っている報告）も同じ仕組みに乗せる。

## メッセージ状態

| 状態 | 表現 |
| --- | --- |
| `pending` | `inbox/` にある（ack 待ち） |
| `delivered` | `acked/` にある（rename で移動済み） |
| `stuck` | `inbox/` に閾値時間を超えて残留 → poller がエスカレート |

enqueue の失敗は同期エラーとしてその場で送信者に返る。「送れたか不明」という状態は存在しない。

## メッセージ形式

```json
{
  "messageId": "20260705T120000-a1b2c3",
  "from": "orchestrator",
  "to": "issue-123-implement",
  "createdAt": "2026-07-05T12:00:00.000Z",
  "kind": "instruction",
  "body": "string"
}
```

`status` フィールドは持たない（置き場所が状態）。`messageId` は送信試行ごとではなく論理メッセージごとに固定する。

## ack の意味論

ack = 「読んで受理した」。**タスク完了ではない**。完了検出は従来どおり PR 自律検出（poll-pr.js）等が担う。

## Phase 1: queue コアモジュール

対象:

- 新規 `scripts/queue.js`
- 新規 `tests/queue.test.js`

実装内容:

- `enqueue(workspace, { to, from, kind, body, messageId? })` — `tmp/` に書いて `inbox/<to>/<messageId>.json` へ rename。`messageId` 省略時は生成、指定時は固定。
- `listPending(workspace, recipient?)` — inbox の走査。
- `ack(workspace, messageId)` — inbox から `acked/` へ rename。対象が既に acked なら成功扱い（冪等）。
- `pruneAcked(workspace, maxAgeMs)` — delivered 済みの掃除。
- rename / read の `EBUSY` / `EPERM`（ウイルススキャナの一時ロック）は短い間隔で数回リトライ。

完了条件:

- 同一 `messageId` の二重 enqueue でファイルが増えない。
- ack の二重実行がエラーにならない。
- tmp 経由 rename で inbox に不完全な JSON が現れない。

## Phase 2: CLI ツール

対象:

- 新規 `scripts/queue-send.js`
- 新規 `scripts/queue-ack.js`
- 新規 `scripts/queue-status.js`
- 新規 tests

実装内容:

- `queue-send.js <recipient> <message> [--kind <k>] [--message-id <id>] [--workspace <path>]` — enqueue して messageId を stdout に出す。
- `queue-ack.js <messageId> [--workspace <path>]` — 全 inbox から messageId を検索して ack（messageId はユニークなので宛先指定不要）。
- `queue-status.js [--workspace <path>]` — pending / delivered / stuck の件数と pending 一覧を表示。
- 3 つとも `--help` / `-h` を実装する（`.claude/rules/skill-asset-help.md` 準拠: help は exit 0、誤用は usage を stderr に出して exit 1）。
- workspace 解決順は send-pane.js と同じ: `GH_MAESTRO_WORKSPACE` env > `--workspace` > CWD 上方探索。

完了条件:

- enqueue → status → ack → status の一連が CLI だけで確認できる。
- `--help` が exit 0 で usage を出す。

## Phase 3: poller

対象:

- 新規 `scripts/queue-poller.js`
- 新規 `scripts/pane-notify.js`（send-pane.js から pane 解決・cwd 検証・pane ロック・Enter 送出を抽出した共有モジュール）
- `scripts/reset-session.js`

実装内容:

- poller は **workspace ごとに 1 プロセス**。worker ごとの sidecar は作らない（プロセス増殖とライフサイクル管理の分散を避ける）。
- 検出は二段構え: `fs.watch(inbox/)` でイベント駆動の即時スキャン（レイテンシ最適化）+ `setInterval` の定期スキャン（既定 5s、取りこぼし回収の本体）。fs.watch は信頼しない。
- pending 検出時、宛先 pane に短い通知を send-text で送る。同一宛先の複数 pending は 1 通にまとめる。
- 通知文テンプレート:

  ```text
  新着メッセージが N 件あります。以下を読み、受理したら
  node <scripts>/queue-ack.js <messageId> を実行してください。
  既に処理済みの場合も ack だけしてください。
  - <inbox絶対パス1>
  - <inbox絶対パス2>
  ```

- 再通知: ack が来ない pending には interval（既定 120s）ごとに再通知する。lastNotifiedAt は poller のメモリ上で管理する（poller 再起動で再通知が走るが、通知は冪等なので無害）。
- エスカレート: pending が閾値（既定 10 分）を超えて残留したら `stuck` とみなし、orchestrator の inbox にエスカレートメッセージを enqueue する。orchestrator 宛メッセージ自身が stuck の場合はログと queue-status 表示に出す。
- **起動は lazy-start**: `queue-send.js` が enqueue 後に `poller.json` の heartbeat を確認し、stale（例: 15s 超）なら poller を detached で起動する。セッション起動順に依存せず自己修復する。
- 二重起動防止: `poller.json` の atomic 作成（`wx` フラグ）+ stale heartbeat の乗っ取り。poller は毎スキャンで heartbeat を更新する。
- `reset-session.js` は `poller.json` の pid を kill し、queue state を掃除する。

完了条件:

- enqueue 後、数秒以内に宛先 pane へ通知が届く。
- ack しない pending に再通知が飛び、ack すると止まる。
- poller を kill しても次の enqueue で自動復活する。
- reset-session 後に poller プロセスが残らない。

## Phase 4: 送信経路の移行

対象:

- `scripts/poll-and-notify.js`
- `scripts/send-pane.js`, `scripts/message-file.js`
- `skills/*/SKILL.md`
- `docs/architect-plan.md`

実装内容:

- orchestrator → worker の通常送信を `queue-send.js` に変更（SKILL.md の指示文を更新）。
- worker → orchestrator の報告（`poll-and-notify.js` の転送）を send-pane 呼び出しから enqueue に変更。通知は poller に任せる。
- `send-pane.js` は CLI 互換のため残すが、内部を「enqueue + poller への即時通知トリガー」の薄いラッパーに置き換える。exit 0 の意味は「enqueue 成功」であり配送成功ではない。
- `.gh-maestro/messages` と `message-file.js` は本 Phase 完了後に廃止する。
- `docs/architect-plan.md` の send-pane 主経路記述を更新する。
- `spawn-worker.js` / `poll-and-notify.js` のフロー変更を含むため、コミット前に `/audit-worker-skills` を実行する（`.claude/rules/worker-flow-audit.md`）。

完了条件:

- 通常送信で `.gh-maestro/messages` に Markdown が増えない。
- worker の報告が orchestrator の inbox 経由で届き、orchestrator が ack できる。
- 既存の `send-pane.js <worker> <message>` CLI が壊れない。

## Phase 5: cleanup / 観測性

対象:

- `scripts/reset-session.js`
- `scripts/queue-status.js`

実装内容:

- acked 済みメッセージの prune（既定 24h 経過）。ack 状態を見ない経過時間だけの削除はしない（pending は消さない）。
- `queue-status.js` で pending / stuck を一覧できるようにし、stuck には最終通知時刻と経過時間を出す。
- reset-session 時、pending が残っていれば警告を出してから掃除する。

完了条件:

- 古い delivered message が deterministic に削除される。
- stuck message を人間が一覧・確認できる。
- reset-session が queue state と poller を安全に掃除できる。

## テスト項目

- 同一 `messageId` の二重 enqueue でファイルが増えない。
- enqueue 直後の inbox ファイルが常に完全な JSON である（tmp 経由 rename）。
- `ack` が inbox → acked へ rename し、二重 ack が成功扱いになる。
- `listPending` が宛先のメッセージだけを返す。
- poller が pending を検出して通知を発火する（pane-notify はモック）。
- ack 済みメッセージに再通知が飛ばない。
- 閾値超過の pending がエスカレートメッセージを orchestrator inbox に生む。
- `poller.json` の stale heartbeat 検出で poller が再起動される。
- 二重起動防止が機能する（2 プロセス目が退出する）。
- `EBUSY` / `EPERM` リトライが機能する。
- 既存 `send-pane.js <worker> <message>` の互換が壊れない。
- 各 CLI の `--help` が exit 0 で usage を出す。

## 実装上の注意

- `tmp/` は必ず `queue/` と同一ボリュームに置く。ボリュームを跨ぐ rename は atomic でない。
- Windows のウイルススキャナは新規ファイルを一時ロックすることがある。rename / read の `EBUSY` / `EPERM` はリトライで吸収する。
- `fs.watch` は取りこぼす前提で扱う。信頼性の本体は定期スキャンであり、watch はレイテンシ最適化にすぎない。
- 通知（send-text）の成功を配送成功として扱うコードを書かない。ack だけが delivered の根拠。
- worker は AI CLI プロセス。再通知で同じ指示を二重処理しないよう、通知文の「処理済みなら ack のみ」を省略しない。
- ack は「読んで受理した」であり「タスク完了」ではない。完了検出のフローを ack に依存させない。
- skill と docs の send-pane 前提を放置しない（Phase 4 で必ず更新する）。
- 将来リモートマシンの worker が必要になった場合のみ、この filesystem コアの上に HTTP facade を足す。コアの API（enqueue / listPending / ack）はその可能性を意識して transport 非依存に保つ。

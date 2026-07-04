# Message Bus + send-pane Fallback 実装計画

策定日: 2026-07-04
対象: `scripts/send-pane.js`, `scripts/message-file.js`, `scripts/spawn-worker.js`, worker 通信, `.gh-maestro/messages`

## 目的

worker / orchestrator 間の通常メッセージ配送を WezTerm 入力注入から切り離し、localhost message bus を主経路にする。

`send-pane.js` は bus 不達時の未確認 fallback として残す。`send-pane.js` の成功は「fallback を発火できた」だけを意味し、配送完了とは扱わない。

## 現状確認

現在の実装では次の問題がある。

- `scripts/message-file.js` は送信ごとに `msg-<timestamp>-<random>.md` を作る。
- `scripts/send-pane.js` は Markdown ファイルへの参照文だけを pane に送る。
- `wezterm cli send-text` の exit 0 は pane への入力注入成功しか示さない。
- worker が本文を読んだか、処理したか、ack したかは判定できない。
- repo は現在 npm 依存ゼロなので、初期実装で sqlite/native module を追加しない。

## 実装方針

- 通常配送は localhost message bus 経由にする。
- message bus は `127.0.0.1` に bind する。
- bus API は session-local token を必須にする。
- 永続化は初期実装では Node 標準ライブラリだけの file-backed queue にする。
- すべての論理メッセージに stable な `messageId` を付ける。
- `messageId` 単位で再送・重複受信を冪等化する。
- fallback payload は `messageId` ベースの固定ファイル名で保存する。
- `send-pane.js` の exit 0 を `delivered` と扱うコードを作らない。
- worker 統合は初期実装では sidecar 方式を優先する。

## メッセージ状態

| 状態 | 意味 |
| --- | --- |
| `queued` | bus が受理し、ack 待ち |
| `delivered` | worker ack 済み |
| `degraded` | bus 不達で fallback を発火したが ack 未確認 |
| `failed` | bus 不達かつ fallback も不可 |

状態遷移:

```text
POST /messages 成功
  -> queued

worker ack 成功
  -> delivered

POST /messages 接続失敗 or timeout
  -> fallback payload 保存
  -> send-pane.js fallback 通知
  -> degraded

fallback も失敗
  -> failed

degraded 後に ack 到着
  -> delivered
```

## メッセージ形式

bus に保存する JSON:

```json
{
  "messageId": "string",
  "from": "orchestrator",
  "to": "issue-123-implement",
  "createdAt": "2026-07-04T00:00:00.000Z",
  "kind": "instruction",
  "body": "string",
  "fallbackRef": "C:/.../.gh-maestro/messages/<messageId>.json",
  "status": "queued"
}
```

`messageId` は送信試行ごとではなく、論理メッセージごとに固定する。

## Phase 1: messageId と fallback payload 固定化

対象:

- `scripts/message-file.js`
- `scripts/send-pane.js`
- `tests/send-pane.test.js`

実装内容:

- `message-file.js` に `messageId` 指定可能な書き込み API を追加する。
- `messageId` 指定時は固定ファイル名を使う。
- 同一 `messageId` の再送では同じファイルを上書きまたは再利用する。
- fallback payload 用ファイルは JSON を第一候補にする。
- 既存 CLI 互換の通常 `send-pane.js <worker> <message>` は壊さない。
- `send-pane.js` に内部向けオプションを追加する。
- 例: `--message-id <id>`
- 例: `--fallback-ref <path>`
- fallback 通知文には `messageId` と payload 絶対パスを含める。

完了条件:

- 同じ `messageId` で fallback を 2 回発火しても新規ファイルが増えない。
- 既存の `send-pane.js` テストが通る。
- fallback 用の新規テストが追加されている。

## Phase 2: bus server / client 追加

対象:

- 新規 `scripts/bus-server.js`
- 新規 `scripts/bus-client.js`
- 新規 tests

API:

- `GET /health`
- `POST /messages`
- `GET /messages?to=<worker>&limit=<n>`
- `POST /acks`

永続化:

```text
.gh-maestro/bus/
  token
  messages/
    <messageId>.json
  acks/
    <messageId>.json
  outbox/
    acks/
```

実装内容:

- bus 起動時に token を作る。
- 全 API で token を検証する。
- `POST /messages` は同一 `messageId` を冪等に扱う。
- `GET /messages` は `to` 宛の未 ack message を返す。
- `POST /acks` は ack を記録し、対象 message を `delivered` にする。
- 書き込みは temp file 作成後 rename で atomic にする。
- bus 不達時用に `bus-client.js` は fallback 呼び出し口を持つ。

完了条件:

- message 登録、取得、ack のテストが通る。
- 同一 `messageId` の二重 POST で message が増えない。
- token 無し/不正 token のリクエストが拒否される。

## Phase 3: sidecar 統合

対象:

- 新規 `scripts/bus-worker-sidecar.js`
- `scripts/spawn-worker.js`
- 必要なら `scripts/reset-session.js`

実装内容:

- worker 起動時に sidecar を detached process として起動する。
- sidecar は `GET /messages?to=<worker>` を poll する。
- pending message 検出時、worker pane に短い通知を送る。
- 通知は「bus に新着あり。payload を処理して ack せよ」という内容にする。
- sidecar 通知は配送成功扱いしない。
- worker が ack できる CLI を用意する。
- 例: `node scripts/bus-ack.js --message-id <id> --workspace <path>`
- bus 不達時の ack は `.gh-maestro/bus/outbox/acks/` に保存し、復旧後 replay する。

完了条件:

- `spawn-worker.js` で worker と sidecar が起動する。
- sidecar が pending message を検出できる。
- worker 宛メッセージが ack されると `delivered` になる。
- worker 終了/リセット時に sidecar の残骸が問題にならない。

## Phase 4: orchestrator 送信経路を bus 優先に変更

対象:

- `send-pane.js` 呼び出し箇所
- `skills/*/SKILL.md`
- `scripts/poll-and-notify.js`
- `docs/architect-plan.md`

実装内容:

- orchestrator から worker への通常送信は `bus-client.js` 経由にする。
- bus 送信成功時は `.gh-maestro/messages` に Markdown を作らない。
- bus 接続失敗/timeout 時のみ `send-pane.js` fallback を使う。
- fallback 成功時は `degraded` として記録する。
- `skills/*/SKILL.md` の「send-pane.js で報告」ルールを bus 対応後の実態に合わせて更新する。
- `docs/architect-plan.md` の `send-pane.js` 主経路記述を更新する。

完了条件:

- 通常送信で Markdown が増えない。
- bus 停止時のみ fallback payload が作られる。
- fallback 成功を delivered と表示しない。
- worker ack 後に delivered へ昇格する。

## Phase 5: cleanup / 観測性

対象:

- `scripts/reset-session.js`
- 新規 status 表示 script または既存 CLI

実装内容:

- delivered 済み message / ack / fallback payload の cleanup を追加する。
- cleanup は経過時間だけでなく ack 状態を見る。
- pending / degraded / delivered / failed 件数を表示できるようにする。
- degraded が残っている場合、人間が確認できるログを出す。

完了条件:

- reset-session が bus state を安全に掃除できる。
- 古い delivered message が deterministic に削除される。
- degraded message を一覧できる。

## テスト項目

- `messageId` 指定時、fallback payload のファイル名が固定される。
- 同一 `messageId` の fallback 再送でファイル数が増えない。
- `POST /messages` が message を queue に保存する。
- 同一 `messageId` の `POST /messages` が冪等。
- `GET /messages?to=...` が宛先 message だけを返す。
- `POST /acks` が message を delivered にする。
- token 不正リクエストが拒否される。
- bus 不達時に fallback が発火し、状態が `degraded` になる。
- bus 不達時の ack が outbox に保存される。
- outbox ack が復旧後に replay される。
- 通常 bus 送信では `.gh-maestro/messages` に Markdown が増えない。
- 既存 `send-pane.js <worker> <message>` の互換が壊れない。

## 実装上の注意

- 初期実装で sqlite を入れない。
- `send-pane.js` の成功を配送成功として扱わない。
- WezTerm fallback を通常 retry として使わない。
- `.gh-maestro/messages` は fallback 専用に寄せる。
- `messageId` は logical message 単位で固定する。
- worker が AI CLI プロセスである前提を忘れない。bus client を直接常駐させる設計は避け、まず sidecar で検証する。
- skill と docs の `send-pane.js` 前提を放置しない。

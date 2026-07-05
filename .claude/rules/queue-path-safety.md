---
paths:
  - "scripts/queue*.js"
  - "scripts/poll-inbox.js"
  - "scripts/remove-worker.js"
---

# キューの名前をパス要素にする前に検証する

`recipient` / `worker` 名など**外部由来の文字列を `.gh-maestro/queue/inbox/<name>` 等のファイルパス要素にする関数は、`path.join` する前に必ず path-safety を検証する。**

このプロジェクトでは同型の path traversal 脆弱性が繰り返し混入している（`purgeInbox` / `poll-inbox` の 2 例、いずれもレビューで security 指摘）。

- 名前を受け取ってパスを組み立てる関数（`purgeInbox` / `receive` / `poll-inbox` の self 等）は、**先頭で `validateField`（区切り文字 `/` `\` と親参照 `..`、空文字を拒否）を通してから** `path.join` する。空・未指定は即エラー。
- `remove-worker` など、名前を検証系関数へ**渡す側**も、その名前が `workers.json` の既知キーである等の妥当性を早期に確認する。raw な `--worker-name` / `--description` 由来値をそのまま流さない。
- 検証は path 構築の前に一度だけ行い、以降のループ内では `validateField` の throw を前提にしてよい。
- 新しく「名前 → inbox パス」を作る経路を足すときも同じ（この rule の `paths` に対象ファイルを追加する）。

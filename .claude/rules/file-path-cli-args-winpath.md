---
paths:
  - "scripts/spawn-worker.js"
  - "scripts/start-review-manager.js"
  - "scripts/create-issue.js"
  - "scripts/msg-send.js"
  - "scripts/run-review-manager.js"
  - "scripts/shared/text-input.js"
---

# ファイルパスを受け取るCLIオプションはtoWinPathを適用する

`--body-file`・`--brief-file`・`--prompt-file`等、ファイルシステムパスを値に取るCLIオプションを新設・変更する際は、値を`fs.readFileSync`等に渡す前に必ず`scripts/win-path.js`の`toWinPath`でラップすること。

Git Bash等からUnixスタイルのパス（`/tmp/...`等）が渡されると、`toWinPath`を経由しない限りWindowsネイティブのNode.jsプロセスが正しく解決できない（PR #116 Review Manager指摘）。

`scripts/shared/text-input.js`の`resolveTextInput`はファイル読み込みの共有ヘルパーだが、パスの正規化（`toWinPath`適用）は呼び出し元の責務である。新しく`resolveTextInput`を呼ぶ箇所を追加する際は、渡す`filePath`が`toWinPath`でラップ済みであることを確認する。

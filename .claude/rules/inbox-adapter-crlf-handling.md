---
paths:
  - "scripts/shared/inbox-adapters/**"
---

# 外部由来の改行は `\r\n` 対応で分割する

`split('\n')`ではなく`split(/\r?\n/)`を使う。GitHub Issueコメント等の外部由来テキストには`\r\n`が混入しうる（PR #138指摘、`\n`のみ分割で行末に`\r`が残りフォーマットが崩れた）。

---
paths:
  - "skills/**"
---

# スキル編集のルール

スキルファイルは必ずリポジトリ（`skills/`）を編集すること。
`~/.claude/skills/` や `~/.gemini/antigravity/skills/` はインストール先であり、直接編集しない。
編集後は `dev` ブランチ（マージ済みの安定ブランチ）で `node scripts/install.js` を実行して反映する。
WIPブランチでの実行は ~/.gh-maestro/ の共有状態を未レビュー・未マージのコードで汚染するため、絶対に行わないこと。

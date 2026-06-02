# gh-maestro

GitHubを永続ストアとして複数のAIエージェントを協調動作させるシステム。設計の詳細は `requirements.md` を参照。

## スキル編集のルール

スキルファイルは必ずリポジトリ（`skills/`）を編集すること。
`~/.claude/skills/` や `~/.gemini/antigravity/skills/` はインストール先であり、直接編集しない。
編集後はインストールスクリプト（`gh-maestro-install.ps1` / `gh-maestro-install.sh`）を実行して反映する。

## エージェントCLI

- **claude (Claude Code CLI)**: ドキュメント → `docs/rag/claude-code/`
- **agy (Antigravity CLI)**: ドキュメント → `docs/rag/antigravity/`
- **wmux**: ドキュメント → `docs/rag/wmux/`

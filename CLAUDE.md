# gh-maestro

GitHubを永続ストアとして複数のAIエージェントを協調動作させるシステム。設計の詳細は `requirements.md` を参照。

## スキル編集のルール

スキルファイルは必ずリポジトリ（`skills/`）を編集すること。
`~/.claude/skills/` や `~/.gemini/antigravity/skills/` はインストール先であり、直接編集しない。
編集後はインストールスクリプト（`gh-maestro-install.ps1` / `gh-maestro-install.sh`）を実行して反映する。

## エージェントCLI

- **claude (Claude Code CLI)**: ドキュメント → `docs/rag/claude-code/`
- **agy (Antigravity CLI)**: ドキュメント → `docs/rag/antigravity/`
- **WezTerm**: ドキュメント → `docs/rag/wezterm/`

## RAGドキュメントの必須参照ルール

各CLIのファイルパス・設定・コマンド・インストール先・動作仕様について実装・変更・回答する前に、
必ず対応する `docs/rag/` のドキュメントを読んで根拠を確認すること。
**推測・類推・訓練データの知識で実装してはならない。**

| 対象 | 参照先 |
|---|---|
| agy のパス・スキル・設定・コマンド | `docs/rag/antigravity/` |
| claude / Claude Code のパス・設定・コマンド | `docs/rag/claude-code/` |
| WezTerm のパス・設定・コマンド | `docs/rag/wezterm/` |

# gh-maestro

GitHubを永続ストアとして複数のAIエージェントを協調動作させるシステム。設計の詳細は `requirements.md` を参照。

## git操作のルール

- ファイル変更が承認されたら、その場でコミット・pushまで完結させる。別途指示されるまで待たない
- `git reset --hard` は実行前に必ずユーザーに確認を取ること。無断実行禁止
- pushがnon-fast-forwardで失敗した場合は `git reset --hard` を使わず、状況をユーザーに報告して方針を確認する

## スキル編集のルール

スキルファイルは必ずリポジトリ（`skills/`）を編集すること。
`~/.claude/skills/` や `~/.gemini/antigravity/skills/` はインストール先であり、直接編集しない。
編集後はインストールスクリプト（`gh-maestro-install.ps1` / `gh-maestro-install.sh`）を実行して反映する。

## agy の `.agents/rules/` について

`.agents/rules/*.md` はプロジェクトルートに置くワークスペースルールファイル。
**エージェントの行動制約（何を実行してよいか）を定義するもの**であり、CLAUDE.md のようなプロジェクト指示書ではない。

- YAML frontmatter でトリガー種別（`glob` / `always_on` / `manual` / `model_decision`）を指定する
- autonomy レベルを `strict` にすると最大限に適用される
- ファイルシステムアクセス・ツール実行・ブラウザ操作などの許可／禁止を記述するもの

**`AGENTS.md` は agy がデフォルトで読むファイルではない。** agy にはプロジェクト指示書の自動ロード機能がない（`.agents/rules/` はあくまで制約定義）。Claude Code 側は `CLAUDE.md` に `@AGENTS.md` と書くことでインポートできる（`docs/rag/claude-code/guide/guide/claude_code_memory_guide.md` 参照）。

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

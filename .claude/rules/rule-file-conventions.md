---
paths:
  - ".claude/rules/**"
  - ".agents/rules/**"
  - "AGENTS.md"
  - "CLAUDE.md"
---

# `.claude/rules/` について

`.claude/rules/*.md` はパス別のルールファイル。コンテキストを消費するため**簡潔に書くこと**。

- `paths` frontmatter なし → 毎セッション強制ロード（CLAUDE.md と同等のコスト）
- `paths` frontmatter あり → 該当パターンのファイルを開いた時のみロード（path-scoped）
- 200行超えると adherence が下がる。詳細は `docs/rag/claude-code/guide/claude_code_memory_guide.md` 参照

# agy の `.agents/rules/` について

`.agents/rules/*.md` はプロジェクトルートに置くワークスペースルールファイル。
**エージェントの行動制約（何を実行してよいか）を定義するもの**であり、CLAUDE.md のようなプロジェクト指示書ではない。

- YAML frontmatter でトリガー種別（`glob` / `always_on` / `manual` / `model_decision`）を指定する
- autonomy レベルを `strict` にすると最大限に適用される
- ファイルシステムアクセス・ツール実行・ブラウザ操作などの許可／禁止を記述するもの

**`AGENTS.md` は agy がデフォルトで読むファイルではない。** agy にはプロジェクト指示書の自動ロード機能がない（`.agents/rules/` はあくまで制約定義）。Claude Code 側は `CLAUDE.md` に `@AGENTS.md` と書くことでインポートできる（`docs/rag/claude-code/guide/guide/claude_code_memory_guide.md` 参照）。

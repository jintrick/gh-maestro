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

# 何を書くか

やってはならないこと・やらなければならないことだけを書く。コーダーが従うために必要な最小限に絞る。

事故の経緯、PR番号、設計判断の理由、スクリプトの挙動の解説は書かない。理由が必要な場合は ADR への参照1行に留める。

# agy の `.agents/rules/` について

`.agents/rules/*.md` はプロジェクトルートに置くワークスペースルールファイル。
**エージェントの行動制約（何を実行してよいか）を定義するもの**であり、CLAUDE.md のようなプロジェクト指示書ではない。

- YAML frontmatter でトリガー種別（`glob` / `always_on` / `manual` / `model_decision`）を指定する
- autonomy レベルを `strict` にすると最大限に適用される
- ファイルシステムアクセス・ツール実行・ブラウザ操作などの許可／禁止を記述するもの

**`AGENTS.md` はすべてのエージェントが読む。** プロジェクト共通の規範はここに書く。

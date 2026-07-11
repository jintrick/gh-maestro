---
paths:
  - "skills/**/*.md"
  - "scripts/install.js"
---

# 共有スキルのテンプレート置換とエージェント別ツール差

共有スキル（`~/.gh-maestro/skills/`）は `install.js` が `canonicalAgent = agents['claude']` の置換で**一度だけ**レンダリングされる。これを読むのは `skill_files_install_destination_directory` を持たない `skillsViaMd` 型エージェント（reasonix等）のみ。claude/agy/codexのように個別インストール先を持つエージェントは、それぞれ専用にレンダリングされたコピー（例: agyは`~/.gemini/antigravity-cli/skills`）を読むため、この一度きりのclaude置換の影響を受けない。したがって特定エージェントのツールに依存する指示を共有スキル向けの置換に書くと、`skillsViaMd`型エージェントでそのツールを持たない場合に**実行不能**になる。

- 実障害: `{{INBOX_POLL_MECHANISM}}` が Monitor ツール前提の指示に展開されたが、reasonix（`skillsViaMd`）は Monitor を持たず指示が実行不能だった（PR #38）。
- 対策: 共有スキルの指示は**エージェント非依存**で書く。ツールに幅がある操作は「Monitor 優先・bash フォールバック」のように代替経路を併記する。
- 新しくプレースホルダや置換を足すときも、canonical=claude で展開された結果が非 Claude エージェントで成立するかを確認する。

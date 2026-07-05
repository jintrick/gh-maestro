---
paths:
  - "skills/**/*.md"
  - "scripts/install.js"
---

# 共有スキルのテンプレート置換とエージェント別ツール差

共有スキル（`~/.gh-maestro/skills/`）は `install.js` が `canonicalAgent = agents['claude']` の置換で**一度だけ**レンダリングし、全エージェント（claude / agy / codex / reasonix）が**同一コピー**を読む。したがって特定エージェントのツールに依存する指示を共有スキルに書くと、そのツールを持たないエージェントで**実行不能**になる。

- 実障害: `{{INBOX_POLL_MECHANISM}}` が Monitor ツール前提の指示に展開されたが、reasonix（`skillsViaMd`）は Monitor を持たず指示が実行不能だった（PR #38）。
- 対策: 共有スキルの指示は**エージェント非依存**で書く。ツールに幅がある操作は「Monitor 優先・bash フォールバック」のように代替経路を併記する。
- 新しくプレースホルダや置換を足すときも、canonical=claude で展開された結果が非 Claude エージェントで成立するかを確認する。

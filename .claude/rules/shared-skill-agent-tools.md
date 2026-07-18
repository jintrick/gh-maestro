---
paths:
  - "skills/**/*.md"
  - "scripts/install.js"
---

# 共有スキルのテンプレート置換とエージェント別ツール差

全エージェント（claude/claude-ds/claude-ds-pro/agy/codex/codex-pro/reasonix）は、`skill_files_install_destination_directory`（`skills/agents.yaml`）で指定された自分専用のインストール先（例: agyは`~/.gemini/antigravity-cli/skills`、reasonixは`~/.reasonix/skills`）から、自分向けに個別レンダリングされたSKILL.mdコピーを読む。`~/.gh-maestro/skills/`（`install.js`が`canonicalAgent = agents['claude']`の置換で一度だけレンダリングする共有コピー）は、orchestrator専用の非SKILL.mdアセット（`issue-template.md`等）を配布するためだけのものであり、ワーカーエージェントがこれを直接読むことはない。

- 過去の実障害（PR #38）: 当時はスキル機構を持たないと誤認されていたreasonix（`skillsViaMd`フラグ）が、この共有コピーをAGENTS.md経由で読む特別扱いになっており、`{{INBOX_POLL_MECHANISM}}`がMonitorツール前提の指示に展開されて実行不能になった。後にreasonixもagy/codexと同様のネイティブスキル機構を持つことが判明し、`skillsViaMd`機構自体を撤去して全エージェント共通のインストール先経由に統一した。
- 教訓: 新しいエージェントを追加する際、まず「本当にネイティブなスキル発見機構を持たないか」を一次情報（公式ドキュメント・リポジトリ）で確認せずに特別扱いのフォールバック経路を作らない。安易に「このエージェントは機構を持たない」と仮定すると、今回のような回避可能な特別扱いと、それに伴う不整合（プロンプト内容の欠落等）を生む。
- 新しくプレースホルダや置換を足す際は、`skills/agents.yaml`の各エージェントのsubstitutionsで、対応するツール（Monitor等）を持たないエージェント向けの代替文言（session-resume系: inbox-supervisor.js経由）が定義されているか確認する。

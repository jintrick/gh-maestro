---
paths:
  - "scripts/agent-defaults.json"
  - "scripts/shared/resolve-config.js"
---

# エージェント起動引数の実行系フィールドはサニタイズ対象を追従させる

`resolveAgentConfig()` は `workspace/.gh-maestro/config.json` によるエージェント設定の上書きを許可しつつ、`command`・`extraArgs` はセキュリティ上の理由でワークスペース側の上書き対象から除外している。

- `agent-defaults.json` の各エージェント定義に `execArgs` 等、実行コマンドラインを直接組み立てる新しいフィールドを追加した場合、`resolveAgentConfig()` 側のサニタイズ対象（除外リスト）にも同時に追加すること。片方だけ更新すると、リポジトリローカルな `config.json` から `--sandbox` や `--skip-git-repo-check` 等の安全性に関わるオプションを差し替えられてしまう（PR #103 Review Manager指摘）。
- 新しい実行系フィールドを追加する際は、既存の `command`・`extraArgs` と同様に扱われているか（サニタイズ対象・型検証・マージ順序のすべて）を横並びで確認する。

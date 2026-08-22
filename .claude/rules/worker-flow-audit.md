---
paths:
  - "scripts/spawn-worker.js"
  - "scripts/shared/link-node-modules.js"
  - "scripts/install.js"
---

# スキルとスクリプトの整合性ルール

以下の**両方**を満たすとき、コミット前に `/audit-worker-skills` を実行して SKILL.md との整合性を確認すること。

1. このファイル（`scripts/spawn-worker.js` / `scripts/shared/link-node-modules.js` / `scripts/install.js`）がステージされている
2. コミットメッセージが**フローの変更**を示している（環境変数の追加・削除・改名、自動前処理の追加・廃止、プロンプト配信方法の変更など）

リファクタ・ログ修正・コメント修正など、ワーカーが受け取る動作環境が変わらない変更は対象外。

このスキルは `.claude/skills/audit-worker-skills/SKILL.md` に定義されている（プロジェクトローカル）。

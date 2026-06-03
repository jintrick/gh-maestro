---
name: gh-maestro
description: gh-maestroセッションをこのワークスペースで起動する。前提条件チェックを行い、自身がorchestratorとして動作を開始する。対象プロジェクトのルートディレクトリで呼び出すこと。
---

## 起動

以下のスクリプトで前提条件をチェックする：

```sh
node "$HOME/.gh-maestro/scripts/gh-maestro-setup.js"
```

チェックを通過したら、`gh-maestro-orchestrator` スキルのゴール定義に従ってorchestratorとして動作を開始する。

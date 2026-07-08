---
name: gh-maestro
description: gh-maestroセッションをこのワークスペースで起動する。orchestratorとして動作を開始する。対象プロジェクトのルートディレクトリで呼び出すこと。
---

## 起動

1. **PID registry sweep**: セッション起動時、前回セッションのクラッシュ残骸を回収するため、必ずPID registryのstale sweepを実行する:

```sh
node "{{SCRIPTS_PATH}}/process-lifecycle.js" sweep --workspace $WORKSPACE
```

2. `gh-maestro-orchestrator` スキルのゴール定義に従ってorchestratorとして動作を開始する。

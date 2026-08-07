---
name: gh-maestro
description: gh-maestroセッションをこのワークスペースで起動する。orchestratorとして動作を開始する。対象プロジェクトのルートディレクトリで呼び出すこと。
---

## 起動

1. **PID registry sweep**: セッション起動時、前回セッションのクラッシュ残骸を回収するため、必ずPID registryのstale sweepを実行する:

```sh
node "{{SCRIPTS_PATH}}/process-lifecycle.js" sweep --workspace $WORKSPACE
```

2. **直近のIssue/PR概況の把握**: 新しくプロジェクトに加わったメンバーと同じ姿勢で、直近何が起きていたかを見出しレベルで把握してからでないと作業を始めない。本文は読まず、タイトル一覧だけを見る（本文を読み込むとコンテクストを消費するため。個別の深掘りが必要になった時点で、その対象だけを読むか、explorerに委譲する）:

```sh
gh issue list --repo $REPO --state open --limit 20
gh pr list --repo $REPO --state merged --limit 15
```

3. `gh-maestro-orchestrator` スキルのゴール定義に従ってorchestratorとして動作を開始する。

---
name: gh-maestro
description: gh-maestroセッションをこのワークスペースで起動する。orchestratorとして動作を開始する。対象プロジェクトのルートディレクトリで呼び出すこと。
---

## 起動

1. **PID registry sweep**: セッション起動時、前回セッションのクラッシュ残骸を回収するため、必ずPID registryのstale sweepを実行する:

```sh
node "{{SCRIPTS_PATH}}/process-lifecycle.js" sweep --workspace $WORKSPACE
```

sweep が終了コード 1 を返した場合は、稼働中ワーカーの除外リストを組み立てられず前回の残骸が回収できていない状態です。原因（ログ）を解消してから次の手順へ進んでください。

2. **直近のIssue/PR概況の把握**: 新しくプロジェクトに加わったメンバーと同じ姿勢で、直近何が起きていたかを見出しレベルで把握してからでないと作業を始めない。本文は読まず、タイトル一覧だけを見る（本文を読み込むとコンテクストを消費するため。個別の深掘りが必要になった時点で、その対象だけを読むか、explorerに委譲する）:

```sh
gh issue list --repo $REPO --state open --limit 20
gh pr list --repo $REPO --state merged --limit 15
```

3. **テスト層宣言の確認**: セッションコンテキストの `TEST_LAYERS_STATUS` を確認する。

   - `declared` の場合は、既存の宣言されたテスト層を使う。
   - `missing` または `invalid` の場合は、`gh-maestro-test-setup` スキルを読み、その手順に従う。提案を人間へ提示して承認を得るまで、対象プロジェクトのテストや設定を変更してはならない。承認後の設定・テスト配置・実行結果の確認まで終えてから次へ進む。

   セッション初期化が `invalid` を報告していても、それだけを理由に初期化やコンテキストの出力をやり直してはならない。出力された状態を使って人間へ状況を提示する。

4. `gh-maestro-orchestrator` スキルのゴール定義に従ってorchestratorとして動作を開始する。

---
signals:
  - script:spawn-worker.js:coder-start
---
# 工程 4. Coder起動【必須】

このファイルは、同じIssueを担当するorchestratorが工程4で実行する手順の正本である。工程番号・必須／任意・入口／待機／遷移を確認して進める。人間への発言と工程横断の不変条件はSKILL.mdに従う。

<!-- gh-maestro-structure: middle-items=0 -->

入口: 工程3でarchitectを起動しないと決めた後、または3-[1/1]の設計論点が解消した後。待つもの: PR監視targetの確認通知とコーダーの計画報告。次: PLAN_REPORTEDを受けて工程5。

実装ワーカーを起動する。共通のspawn-worker.js呼び出しには `--guidance-signal coder-start` を付ける。explorer・diagnostician・architect等の起動には付けない。タスクの特長（設計上の複雑さや影響の大きさなど）を自律的に判断して `gh-maestro-coder` と `gh-maestro-senior-coder` のどちらを使うか選択する（「ワーカーの使い分け」「ワーカーの起動」参照）。**コーダーは実装に着手する前に、必ず計画をorchestratorに報告する。**



通常経路のPR監視targetはspawn-worker.jsでコーダーを起動した直後に設定する。plugin monitorが既に/gh-maestro起動時に固定コマンドとして起動しているため、Issue番号をMonitorの引数へ埋め込んだり、30分上限の通常Monitorを張ったりしない。plugin monitorがPR検出からマージ検知までセッション中のtargetを監視するため、通常のMonitorを張り直さない。

~~~sh
node "{{SCRIPTS_PATH}}/activate-pr-monitor.js" \
  --issue <ISSUE> --workspace "$WORKSPACE" --base-branch "$BASE_BRANCH"
~~~

activate-pr-monitor.jsはpr-monitor-target.jsonを原子的に更新し、固定のpoll-pr-monitor.jsがtargetを検出してpoll-pr.jsを起動する。target切替では旧poll-prとslow子プロセスを停止してから新世代を1回だけ起動する。Issue終了時はfinalize-issue.jsが一致するtargetを消す。PR_MONITOR_TARGET_SET通知でIssue・generation・workspaceを確認する。

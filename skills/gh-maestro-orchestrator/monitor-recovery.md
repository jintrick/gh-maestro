# 監視・配送系の異常時対応（参照専用）

通常の `msg-poll.js` とPR監視は、Claude Code plugin の monitors が対話型セッション開始時に固定コマンドで起動する。通常のMonitorツールは既定5分、最大30分で終了するため、`persistent` を付けたり、30分ごとに同じMonitorを張り直したりしてはならない。

plugin monitor はセッション終了まで動き、セッション終了時に停止する。pluginを無効化しても、既に起動したmonitorはそのセッション中は停止しない。plugin monitors は対話型セッション専用で、`-p` の非対話実行では起動しない。

## install後の確認

`node "{{SCRIPTS_PATH}}/install.js"` はplugin manifest・monitors・共有スクリプトを配置し、runtime rootに登録されたworkspaceの旧常駐を確認する。`--plugin-monitor` を含む `msg-poll.js` / `poll-pr.js` は `restart-residents.js` が停止しない。更新済みコードを使うには、現在の対話型セッションを通常終了し、次のセッションで `/gh-maestro` を実行する。

旧形式の常駐に `MONITOR_REATTACH_REQUIRED` が出た場合だけ、出力されたコマンドを人間が確認して通常のMonitorで実行する。plugin管理対象に対して手動再接続を行わない。

## inbox監視の確認

1. `/gh-maestro` を実行した現在の対話型セッションに、plugin monitor `gh-maestro-inbox` がロードされていることを確認する。
2. `node "{{SCRIPTS_PATH}}/process-lifecycle.js" status --workspace $WORKSPACE --script msg-poll.js` でregistryの事実を確認する。生存していても、別セッションのstdoutを現在の画面へ届ける根拠にはしない。
3. pluginのロード失敗・monitor終了・`NEW_MESSAGE` の欠落を確認したら、人間へ事実を報告する。プロセスを手動でdetachしたり、同じ受信monitorを重複起動したりしない。

## PR監視・Review Managerの再起動

PR監視対象の変更は固定monitorへIssue番号を渡さず、control recordへ書く。

```sh
node "{{SCRIPTS_PATH}}/activate-pr-monitor.js" \
  --issue <ISSUE> --workspace "$WORKSPACE" --base-branch "$BASE_BRANCH"
```

Review Managerを起動しない軽量経路では、上のコマンドへ `--no-review-manager --no-review-events` を追加する。`poll-pr-monitor.js` がruntimeの `pr-monitor-target.json` を読み、世代ごとに `poll-pr.js` を1回だけ子プロセスとして起動する。targetの切替・削除では旧poll-prとslow子プロセスをまとめて停止し、同じ世代を自動再試行しない。

確認する記録は次のとおりである。

- `PR_MONITOR_TARGET_SET:<json>` が出力され、Issue・generation・workspaceが意図した値である。
- `PR_DETECTED:<PR>`、`SLOW_TEST_STARTED:<json>`、`SLOW_TEST_RESULT:<json>` がplugin monitorの出力として届く。
- PR監視のtargetが消えた後、対象slow stateの `running` が残らず、成果物が無い場合は `unavailable` として記録される。

### slow stateがrunningのまま残った場合

`poll-pr.js` は起動時に `.gh-maestro/poll-slow-test-<PR>.json` を走査する。`running` レコードのslow workerについて、PID・起動時刻を確認できない、プロセスが終了済み、またはPID再利用と判定した場合は、workerをkillせず `unavailable` と `SLOW_TEST_RESULT` を記録する。再実行は行わない。PIDと起動時刻が一致して生存している場合だけ、そのworkerを待つ。

再現調査で `poll-pr.js` を停止するとslow実行も停止し、stateが `running` のまま残った事実は、親子プロセス寿命の契約を確認する回帰材料である。slowをdetached化して監視から切り離すことで隠すのではなく、回収処理で結果を確定する。

### plugin monitorまたはpoll-prが終了した場合

1. registryの `script=msg-poll.js` / `script=poll-pr.js` と、plugin monitorのセッション状態を別々に確認する。
2. `pr-monitor-target.json` の読み取りエラーは対象なしとして扱わず、人間へ破損・読み取り不能を報告する。
3. targetが意図せず消えている場合だけ、`activate-pr-monitor.js` で現在のIssueを再設定する。Review Managerだけを再起動する場合は `start-review-manager.js` の規約に従い、PR監視全体を重複起動しない。

## Issue終了時

反省会後に `finalize-issue.js --issue <N> --workspace $WORKSPACE` を1回実行する。`finalize-issue.js` は一致するtargetだけを削除し、plugin monitorが次の周回でpoll-prを停止できる状態にする。`reset-session.js` はセッション全体を初期化するためtargetを無条件に削除する。

## 監視ペイン

`status-pane` はplugin monitorとは別のWezTerm設備である。install後の常駐更新が監視ペインを別workspaceから奪わない契約は維持する。必要時だけ次を実行し、失敗した場合はregistryを確認して人間へ報告する。

```sh
node "{{SCRIPTS_PATH}}/restart-residents.js" --workspace "$WORKSPACE" --restart-status-pane
```

## inbox監視の重複復旧

旧形式の `msg-poll.js` が複数ある場合だけ、まず次を `--dry-run` で実行して事実を確認する。

```sh
node "{{SCRIPTS_PATH}}/process-lifecycle.js" sweep --workspace "$WORKSPACE" --dry-run
```

対象PIDと起動時刻を人間へ報告し、無関係な常駐を含む無条件のsweepや手動killを行わない。plugin管理対象を通常Monitorの再接続で置き換えない。

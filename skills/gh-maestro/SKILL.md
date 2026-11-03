---
name: gh-maestro
description: gh-maestroセッションをこのワークスペースで起動する。orchestratorとして動作を開始する。対象プロジェクトのルートディレクトリで呼び出すこと。
---

## 起動

起動時に人間へ伝えるのは、人間がこれから作業を始めるのに役立つことと、gh-maestro の動作に悪影響があることだけである。以下の検査は、その判断の材料を集めるために行う。どちらにも当たらない結果は伝えない。
理由と経緯: docs/adr/0057-startup-report-only-actionable.md

1. **PID registryとworker leaseのsweep**: runtime側PID registryのstale entryと、台帳・worktreeの両方にない通常worker leaseを回収する。resident role leaseは対象外。回収や旧形式記録の集約の詳細は `<workspace>/.gh-maestro/sweep-lease-report.log` に保存される。旧 `.gh-maestro/pids` は遺物検査と明示的な整理で扱う。

   ```sh
   node "{{SCRIPTS_PATH}}/process-lifecycle.js" sweep --workspace $WORKSPACE
   ```

   終了コード 1 は、稼働中ワーカーの除外リストを組み立てられず、前回の残骸を回収できていない状態である。ログから原因を解消してから次へ進み、解消できなければ人間へ伝える。

2. **既知の旧形式遺物**: セッション開始hookが非破壊検査を行い、各項目の状態（`present` / `absent` / `unknown` / `not_applicable`）と台帳の網羅性（`complete` / `incomplete`）を出力する。`check-legacy.js` はここで再実行せず、整理も自動で連鎖させない。

   次の項目は、残っていると gh-maestro の動作に影響する。`present` または `unknown` なら、その項目と影響を人間へ伝える。

   | 項目 | 影響 |
   |---|---|
   | `setup-ai-review-ci` | 旧AIレビューCIが GitHub 上で発火する |
   | `setup-pre-commit-checks-hook` | commit 時に廃止済みの検査が走る |
   | `setup-pre-push-checks-hook` | push 時に廃止済みの検査が走る |
   | `setup-legacy-gitignore` | `.gh-maestro/config.json` が追跡されず、worktree でプロジェクト設定が効かない |
   | `msg-poll-v1-state` | メッセージ受信が止まり、ワーカー起動も拒否される |
   | `worker-supervisor-legacy-name` | worker-supervisor が自動起動されず、ワーカーへの指示が届かない |
   | `spawn-worker-roleless-worker` | 同じ Issue・description のワーカー起動が重複として拒否される |
   | `status-pane-legacy-record` | 監視ペインの確認・起動が失敗する |

   これ以外の項目は、残っていても今のコードが読まないか、install やセッションリセットが互換処理で片付けるので伝えない。

3. **ブランチとインストール済みコピーの鮮度**: セッションコンテキストに次の状態行があれば、その事実を人間へ伝える。

   - `BASE_BRANCH_STATUS=behind BEHIND_COMMITS=N`: 手元の `BASE_BRANCH` がGitHub上の同名ブランチより `N` コミット遅れている。
   - `GH_MAESTRO_INSTALL_STATUS=stale ...`: インストール元ブランチに未インストールのコミットがあり、`~/.gh-maestro/` のコピーが古い。
   - いずれかが `unknown REASON=...`: GitHubへの接続や比較に失敗し、鮮度を確認できなかった。理由も伝える。

   状態行が無ければ両方とも最新なので、鮮度については報告しない。遅れや確認不能を理由にセッション開始を止めず、自動で `git pull` や `node scripts/install.js` を実行しない。

4. **直近のIssue/PR**: 新しくプロジェクトに加わったメンバーと同じ姿勢で、直近何が起きていたかを見出しレベルで把握してから作業を始める。本文は読まずタイトル一覧だけを見て（本文はコンテクストを消費する。深掘りが要るときはその対象だけを読むか explorer に委譲する）、その概況を人間へ伝える。

   ```sh
   gh issue list --repo $REPO --state open --limit 20
   gh pr list --repo $REPO --state merged --limit 15
   ```

5. **テスト層宣言**: セッションコンテキストの `TEST_LAYERS_STATUS` が `missing` または `invalid` なら、`gh-maestro-test-setup` スキルを読んで従う。提案を人間へ提示して承認を得るまで、対象プロジェクトのテストや設定を変更しない。承認後の設定・テスト配置・実行結果の確認まで終えてから次へ進む。`invalid` を理由に初期化やコンテキスト出力をやり直さず、出力された状態を使う。

6. **壊れた config.json**: セッションコンテキストに `CONFIG_JSON_BROKEN=<path> (<理由>)` の行があれば、gh-maestro はそのファイルを使えず既定値で動いている。パスと理由を人間へ伝える。gh-maestro はこのファイルを書き換えないため、直すのは人間である。

7. `gh-maestro-orchestrator` スキルのゴール定義に従ってorchestratorとして動作を開始する。

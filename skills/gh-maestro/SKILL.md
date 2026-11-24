---
name: gh-maestro
description: gh-maestroセッションをこのワークスペースで起動する。orchestratorとして動作を開始する。対象プロジェクトのルートディレクトリで呼び出すこと。
---

## 起動

起動コンテキストに `[gh-maestro session hook failed]` があるか `[gh-maestro session context]` があるかを最初に確認し、結果に応じて分岐する。

### 起動フックが失敗した場合

コンテキストに `[gh-maestro session hook failed]` が含まれている場合、セッション情報の生成は途中で止まっており、`$WORKSPACE`・`$REPO`・`$BASE_BRANCH`・`$SESSION_ID` は存在しない。以下の確認手順（sweep・Issue一覧等）や `gh-maestro-orchestrator` の通常運用へ進んではならない。

次の4点を人間へ明確に伝えて、その場で起動を終了する。

1. **失敗した段階**: `FAILED_STAGE` に記載されたスクリプト名
2. **失敗の理由**: `REASON` に記載されたエラー内容
3. **人間が取るべき対処**: 理由から特定できる具体的な復旧手順や確認事項
4. **再実行の案内**: 対処を完了したうえで `/gh-maestro` を再実行すること

### セッション情報が揃っている場合

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

4. **dev ブランチの作成事実**: セッションコンテキストに `[gh-maestro dev branch created]` があれば、setup が今回 `dev` を新しく作った。次の値を人間へ伝える。
   - `DEV_BASE_BRANCH`（分岐元）と `DEV_BASE_COMMIT`
   - `CURRENT_BRANCH`（人間が今いるブランチ）と `CURRENT_BRANCH_COMMITS_NOT_IN_DEV`（そのブランチにあって dev に無いコミット数）
   - `DEV_PUSH`（`pushed` / `failed` / `skipped`）と `DEV_PUSH_COMMITS_NEW_ON_REMOTE_BASE`（push で GitHub 上の分岐元に無かったコミットが新たに出た数）
   - `unknown REASON="..."` は確定できなかった値である。理由も伝える。`DEV_PUSH` が `failed` のときは、push できていないことを伝える。
   - `CURRENT_BRANCH_COMMITS_NOT_IN_DEV` が 1 以上、または `unknown` のときは、人間の最新の作業が dev に入っていない可能性がある。最初のワーカーを起動する前に、このまま dev を基準に進めてよいか、人間が dev を更新してから進めるかを1問で確かめ、回答を得るまでワーカーを起動しない。orchestrator は dev を自分で書き換えない。
   - 両方とも 0 のときは伝えるだけで待たない。`DEV_PUSH_COMMITS_NEW_ON_REMOTE_BASE` が 1 以上のときは、GitHub に出た件数を伝える。出たコミットは取り消せないため、これを理由に待たない。

5. **進行中・直近の作業状況**: まず GitHub 上の未解決 Issue・PR と既存のワーカー記録から中断中の作業と直近の動きを把握する。

   ```sh
   gh issue list --repo $REPO --state open --limit 20
   gh pr list --repo $REPO --state open --limit 20
   gh pr list --repo $REPO --state merged --limit 15
   ```

   開いた Issue 番号 `<N>` ごとに次を実行し、前のセッションのワーカー記録が残っているかも確認する（`--json` 指定によりローカル記録だけを照会し、配列が空でなければ記録あり。読み取り失敗が stderr に出た場合はその事実も伝える）。開いた PR のブランチ名やタイトルから紐づく Issue 番号を読み取れないときは、その PR の本文だけを確認して Issue 番号を補う。

   ```sh
   node "{{SCRIPTS_PATH}}/worker-status.js" list --workspace $WORKSPACE --issue <N> --json
   ```

   - **中断中の作業**: マージされていない開いた PR がある Issue、またはワーカーの記録が残っている Issue がある場合は、起動時の報告で Issue 番号・PR 番号（PR 未作成時は PR なし／ワーカー記録あり）とともに人間へ伝える。該当する作業が無いときは、そのことを報告しない。起動時点ではワーカーや PR 監視を自動で再開せず、再開するかは人間の判断を待つ。
   - **直近の Issue/PR 概況**: 開いた Issue と直近マージ済み PR のタイトル一覧から、プロジェクトで直近何が起きていたかを見出しレベルで把握し、その概況を人間へ伝える（本文やコメント全文はここで読まない）。

6. **テスト層宣言**: セッションコンテキストの `TEST_LAYERS_STATUS` が `missing` または `invalid` なら、`gh-maestro-test-setup` スキルを読んで従う。提案を人間へ提示して承認を得るまで、対象プロジェクトのテストや設定を変更しない。承認後の設定・テスト配置・実行結果の確認まで終えてから次へ進む。`invalid` を理由に初期化やコンテキスト出力をやり直さず、出力された状態を使う。

7. **壊れた config.json**: セッションコンテキストに `CONFIG_JSON_BROKEN=<path> (<理由>)` の行があれば、gh-maestro はそのファイルを使えず既定値で動いている。パスと理由を人間へ伝える。gh-maestro はこのファイルを書き換えないため、直すのは人間である。

8. `gh-maestro-orchestrator` スキルのゴール定義に従ってorchestratorとして動作を開始する。人間が中断中の作業の再開を選んだ場合は、`gh-maestro-orchestrator` の「中断中の作業の再開」に従って現在工程を読み取ってから進める。

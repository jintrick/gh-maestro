# 軽量PR経路

影響範囲が限定的でReview Managerのレビューを起動するコストに見合わない変更でも、ベースブランチへ直接commit・pushしてはならない。タイトルだけのアンカーIssueを作成し、通常のPR監視からReview Managerを外す。この軽量経路ではslow層とGitHub CI checksの照会を行わず、PR検出、テスト結果の申告、マージ状態の監視を行う。Review Managerを起動しないだけの通常PR（監視復旧やrevert用PRなど）は軽量経路ではなく、slow層とGitHub CI checksの照会を維持する。

例外は次の2つだけである。どちらもこの経路を使わず、アンカーIssue・PR・slow層・マージ依頼を作らずにベースブランチへ直接commit・pushする。

- `adr.md`が定義するADRの追加・改訂（直接commit・pushしてよい）。
- 反省会で人間が承認した、対象プロジェクトの `.claude/rules/` の変更（承認後すぐにorchestrator自身が直接commit・pushする。手順は `retrospective.md`「反省会後のアクション」）。

このファイルの「直接commit・pushしない」「ドキュメントだけでも省略しない」は、この2つには適用しない。

## 実行前の前提

- セッション変数 `$REPO`、`$WORKSPACE`、`$BASE_BRANCH` が設定されていること。
- `$WORKSPACE` に未コミットの無関係な変更がないこと。必要なら先に状態を人間へ確認する。
- 変更対象の要件と、PRのタイトル・本文に使う説明が確定していること。

## 手順

### 1. タイトルだけのアンカーIssueを作成する

本文ファイルは作らない。`--title-only` は明示的にタイトルだけのIssueを作るモードである。assistantはIssue作成時に自動起動されない。

```sh
CREATE_OUTPUT=$(node "{{SCRIPTS_PATH}}/create-issue.js" \
  --title "<変更内容の短いタイトル>" \
  --title-only \
  --repo "$REPO" --workspace "$WORKSPACE")
ISSUE=$(printf '%s\n' "$CREATE_OUTPUT" | sed -n 's/^ISSUE_CREATED:\([0-9][0-9]*\).*/\1/p')
test -n "$ISSUE"
```

`--body-file` と `--title-only` は同時に指定しない。どちらも指定しない起票は失敗させる。

### 2. ベースブランチから作業ブランチを作成する

```sh
cd "$WORKSPACE"
BRANCH="issue-${ISSUE}-lightweight-<slug>"
git switch --create "$BRANCH" "$BASE_BRANCH"
```

ブランチ名は `issue-<Issue番号>-<slug>` の形式にする。変更の実装と確認が済んだら、変更をステージしてcommit・pushする。

```sh
git add -A
git commit -m "<変更内容の短いタイトル>"
git push -u origin "$BRANCH"
```

BASE_BRANCHへ直接commit・pushしない（冒頭の例外2つを除く）。変更がドキュメントだけでも、この経路を省略しない。反省会で承認された `.claude/rules/` の変更は「ドキュメントだけの変更」ではなく冒頭の例外であり、この経路に乗せない。

### 3. Review ManagerなしでPRを作成する

`gh-create-pr.js` はPRのbaseを環境変数から解決するため、セッションの `$BASE_BRANCH` を渡す。実行するシェルに応じて環境変数を設定してから `node` を呼ぶ。

POSIXシェル:

```sh
export GH_MAESTRO_BASE_BRANCH="$BASE_BRANCH"
node "{{SCRIPTS_PATH}}/gh-create-pr.js" \
  --title "<変更内容の短いタイトル>" \
  --body "関連Issue: #$ISSUE" \
  --repo "$REPO"
unset GH_MAESTRO_BASE_BRANCH
```

PowerShell:

```powershell
$env:GH_MAESTRO_BASE_BRANCH = $BASE_BRANCH
node "{{SCRIPTS_PATH}}/gh-create-pr.js" `
  --title "<変更内容の短いタイトル>" `
  --body "関連Issue: #$ISSUE" `
  --repo $REPO
Remove-Item Env:GH_MAESTRO_BASE_BRANCH
```

PR本文にはIssueを自動クローズするキーワードを入れない。Issueのクローズは通常の後始末で行う。

### 4. 軽量PRのtargetを設定し、slow層とCI checksを省く

plugin monitorは `/gh-maestro` 起動時に固定コマンドで起動済みなので、通常のMonitorを追加で張らない。次のコマンドでPR監視targetだけを設定する。

```sh
node "{{SCRIPTS_PATH}}/activate-pr-monitor.js" --issue "$ISSUE" \
  --no-review-manager --no-review-events --workspace "$WORKSPACE" --base-branch "$BASE_BRANCH"
```

固定の `poll-pr-monitor.js` がtargetを読み、`poll-pr.js`を1回だけ起動する。`--no-review-manager`でReview Managerの起動を、`--no-review-events`でinline/formalレビューAPI監視を抑止する。この2つを併用した軽量経路では、初回検出時・`PR_PUSH`時ともslow層とGitHub CI checksの照会を行わない。PR検出とマージ・クローズ監視は継続する。`run-slow-tests.js` を別途手動で回して代替してはならない。

確認する記録は次のとおりである。

- `REVIEW_MANAGER_STARTED` / `REVIEW_MANAGER_ALREADY_RUNNING` が出力されない。
- 対象PRについて `SLOW_TEST_STARTED` / `SLOW_TEST_RESULT` が出力されない。
- 対象PRについて `CI_CHECK_FAILED` / `CI_CHECKS_COMPLETE` / `CI_CHECKS_EMPTY` / `CI_CHECKS_UNAVAILABLE` が出力されない。
- PR検出とマージ・クローズ監視の記録は通常どおり確認できる。
- この軽量PR経路を実際に1回運用確認し、slow層とCI checksの通知がないことを確認した記録をIssueコメントに残す。

slow層またはGitHub CI checksの通知が出た場合は、監視経路の設定を確認して人間へ報告する。通知がないこと自体は軽量PR経路の期待動作である。

### 5. マージ後の後始末

**軽量PR経路に反省会は無い。** Review Managerを起動しないためレビュー指摘が構造的に発生せず、反省会の分析対象は常にゼロである。`SKILL.md`「13. 反省会と後始末」の13-[2/3]にある「分析対象がゼロなら人間に確認する」は、この経路には適用しない。飛ばしてよいかを人間に尋ねない。

マージを検出したらベースブランチを最新化し、`scripts/` または `skills/agents.yaml` に触れた変更なら `node scripts/install.js` を実行してから、`finalize-issue.js` でアンカーIssueをクローズする。

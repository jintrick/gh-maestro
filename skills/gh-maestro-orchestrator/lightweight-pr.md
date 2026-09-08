# 軽量PR経路

影響範囲が限定的でReview Managerのレビューを起動するコストに見合わない変更でも、ベースブランチへ直接commit・pushしてはならない。タイトルだけのアンカーIssueを作成し、通常のPR監視からReview Managerだけを外す。この経路でもPR検出、slow層、テスト結果の申告、マージ状態の監視は残る。

## 実行前の前提

- セッション変数 `$REPO`、`$WORKSPACE`、`$BASE_BRANCH` が設定されていること。
- `$WORKSPACE` に未コミットの無関係な変更がないこと。必要なら先に状態を人間へ確認する。
- 変更対象の要件と、PRのタイトル・本文に使う説明が確定していること。

## 手順

### 1. タイトルだけのアンカーIssueを作成する

本文ファイルは作らない。`--title-only` は明示的にタイトルだけのIssueを作り、assistantを自動起動しないモードである。

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

BASE_BRANCHへ直接commit・pushしない。変更がドキュメントだけでも、この経路を省略しない。

### 3. Review ManagerなしでPRを作成する

`gh-create-pr.js` はPRのbaseを環境変数から解決するため、セッションの `$BASE_BRANCH` を渡す。

```sh
GH_MAESTRO_BASE_BRANCH="$BASE_BRANCH" node "{{SCRIPTS_PATH}}/gh-create-pr.js" \
  --title "<変更内容の短いタイトル>" \
  --body "関連Issue: #$ISSUE" \
  --repo "$REPO"
```

PR本文にはIssueを自動クローズするキーワードを入れない。Issueのクローズは通常の後始末で行う。

### 4. `--no-review-manager` でPR監視を起動する

orchestratorのMonitorで、次のコマンドを `persistent: true` として起動する。

```sh
node "{{SCRIPTS_PATH}}/poll-pr.js" "$ISSUE" \
  --no-review-manager --workspace "$WORKSPACE" --base-branch "$BASE_BRANCH"
```

このフラグによりReview Managerの起動だけを抑止する。PR検出後のslow層実行、slow完了時のテスト申告コメント更新、PRのマージ・クローズ監視は抑止しない。`run-slow-tests.js` を別途手動で回して代替してはならない。

確認する記録は次のとおりである。

- `REVIEW_MANAGER_STARTED` / `REVIEW_MANAGER_ALREADY_RUNNING` が出力されない。
- `SLOW_TEST_RESULT:<json>` が対象PRのHEADについて届く。
- slow層完了後、対象HEADに対するテスト申告コメントがIssueまたはPRへ投稿される。

結果に `SLOW_TEST_RESULT` またはテスト申告がない場合、推測で再実行せず、監視ログと申告の正本を確認して人間へ報告する。

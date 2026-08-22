# 保留Issueの操作手順（参照専用）

## 何を積むか

SUGGESTION・軽微なDRY違反・スタイル指摘はコーダーへ即転送せず、**専用の保留Issue** に永続化する。チャットに書き留めるとセッションを跨いだ瞬間に蒸発する。

`gh-maestro-pending` ラベルを持つIssueは**リポジトリ全体で常に1件のみ**（PR番号をまたいで使い回すストックIssue）。新規作成は禁止に近い最終手段であり、触る前に必ず先にラベル検索する。

過去PRを遡及して保留候補を探す場合は explorer ワーカーに委譲し、自分では手読みしない。

## いつ切り出すか

保留Issueは終わりのないストックであり、クローズという概念がない。対応することが決まった項目は保留Issueから**切り出して新規Issueを作成**し、コーダーへの実装指示はその新規Issueに対して行う。実装が完了しクローズされるのは常にこの切り出し先Issueであり、保留Issue自体がクローズされることはない。

保留Issueは消化対象のバックログではない。切り出し=Issue=PR=Review Manager起動というコストを負うため、その負担に見合う塊に育つまで意図的に据え置く仕組みだ。人間から直接「保留を見てまとめてくれ」と言われた場合も、この原則に沿って切り出す単位を判断する。

## 保留Issueの取得（触るたびに毎回実行）

PR番号に依存しない条件でラベル検索する。1件でも見つかればそれを使う。取得は毎回このラベル検索で行い、結果をローカルにキャッシュしない（保留Issueはリポジトリ全体で1件のストックであり、ラベル検索が唯一の正本）。

```sh
# 常にラベルのみで検索する（PR番号を条件に含めない — ストックIssueはPRと無関係な内容のため検索から漏れる）
PENDING_ISSUE=$(gh issue list --repo $REPO \
  --label gh-maestro-pending --state open \
  --json number -q '.[0].number')
```

## 見つからなかった場合のみ新規作成

上記でゼロ件だったときに限り作成する。

**ここだけは意図的に `gh issue create` を直接使う例外。** `--label` の付与が必須だが `create-issue.js` は `--label` を持たない。ラベルで管理する使い捨てでないストックIssue（実装アンカーではない）なので、assistant自動起動も不要。「切り出し」（下記）は通常のアンカーIssueを作るため、この例外に倣わず必ず `create-issue.js` を使うこと。

```sh
if [ -z "$PENDING_ISSUE" ]; then
  PENDING_ISSUE=$(gh issue create --repo $REPO \
    --title "保留SUGGESTION" \
    --body "PRレビューのトリアージで保留判定されたSUGGESTION一覧。BLOCKERがゼロになったら人間に提示する。" \
    --label "gh-maestro-pending" \
    --jq '.number')
fi
```

## 保留Issueへの追記

人間が「保留Issueに積む」を選んだら、その場で追記する。「後で書く」は禁止。

```sh
node "{{SCRIPTS_PATH}}/write-draft.js" /tmp/pending-<N>.md --stdin <<'EOF'
[保留] <path>:<line> — <内容>
EOF
node "{{SCRIPTS_PATH}}/comment-issue.js" \
  --issue $PENDING_ISSUE --repo $REPO --workspace $WORKSPACE \
  --body-file /tmp/pending-<N>.md
```

## 切り出し

切り出し先も通常のアンカーIssueなので、`gh issue create` を直接叩かない。唯一の呼び出し口は `create-issue.js`（「アセット」参照）——これを経由しないと切り出し先Issueにassistantが自動起動されない。

```sh
# 対応する項目をグループ化して新規Issueとして切り出す
node "{{SCRIPTS_PATH}}/write-draft.js" /tmp/issue-extract.md --stdin <<EOF
Issue #$PENDING_ISSUE の保留項目から切り出し。
- <path>:<line> — <内容>
EOF

# --workspace は必ず明示する（省略するとassistant起動先がずれる。「1. 要件確定」参照）
CREATE_OUTPUT=$(node "{{SCRIPTS_PATH}}/create-issue.js" \
  --title "<切り出した対応内容の要約>" \
  --body-file /tmp/issue-extract.md \
  --repo $REPO --workspace $WORKSPACE)
NEW_ISSUE=$(echo "$CREATE_OUTPUT" | sed -n 's/^ISSUE_CREATED:\([0-9]*\).*/\1/p')

# 保留Issue側は、元の[保留]コメント自体を検索して削除する（新規コメントは作らない・書き換えない）
PENDING_COMMENT_ID=$(gh api "repos/$REPO/issues/$PENDING_ISSUE/comments" --paginate \
  --jq '.[] | select(.body == "[保留] <path>:<line> — <内容>") | .id')
# 該当コメントが1件に一意特定できない場合（0件・複数件）は削除せず人間に確認する
gh api -X DELETE "repos/$REPO/issues/comments/$PENDING_COMMENT_ID"
```

コーダーへの実装指示・PR作成は `$NEW_ISSUE` に対して行い、そのIssueが実装完了時にクローズされる（通常のIssue対応フローと同じ）。


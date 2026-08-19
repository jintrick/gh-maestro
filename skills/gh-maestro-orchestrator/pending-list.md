# 保留Issueの操作手順（参照専用）

このファイルは `SKILL.md` の「保留リスト」から参照される。**保留Issueを実際に触るとき（PR検出時の確保・「保留Issueに積む」判定時の追記・対応が決まった項目の切り出し）にだけ開く。**

何を保留に回すか、いつ切り出すかという判断原則は `SKILL.md` 側にある。このファイルは操作手順だけを持つ。

## 保留Issueの取得（PR検出のたびに毎回実行）

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

### 切り出し

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


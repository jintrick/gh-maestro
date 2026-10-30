---
signals:
  - none
---
# 工程 1. 要件確定【必須】

このファイルは、同じIssueを担当するorchestratorが工程1で実行する手順の正本である。工程番号・必須／任意・入口／待機／遷移を確認して進める。人間への発言と工程横断の不変条件はSKILL.mdに従う。

<!-- gh-maestro-structure: middle-items=3 -->

入口: 人間から変更要望、または既存Issueの要件確定を依頼されたとき。待つもの: 要件・制約・対象外・受け入れ条件の人間による承認。次: 承認後に工程2。

人間と協働して対象 Issue を起草・作成し、目的・制約・対象外・受け入れ条件・既決事項・未決事項を Issue 本文で確定する。単独で要件を決めない。

確定したら「この Issue を渡されたコーダーが実装計画を立てられるか」を自問し、NO なら人間と要件を確認して修正する。

**実装詳細（変更方針・作業分割・実装者が選ぶ検証方法）は Issue 本文には書かない。** これらはコーダーが実装着手前の計画フェーズで作成し、計画として投稿する。Issue本文は「何を実現したいか」（目的・制約・対象外・受け入れ条件）に徹する。求める振る舞いと、その振る舞いを満たしたと判断するために必要な確認の結果は要件であり、受け入れ条件に含める。承認する計画が既存の受け入れ条件にない振る舞いや確認を約束している場合は、工程6で承認前に取り込む。ただし、問題が起きている場所の特定（ファイル名・パス・識別子）は実装詳細ではなく要件の一部である。一般名詞へ言い換えず、そのまま書く。

#### 1-[1/3] 保留Issueから切り出す場合【任意】

起票する内容が保留Issue（`gh-maestro-pending` ラベル）の項目に由来する場合は、`{{SHARED_SKILLS_PATH}}/gh-maestro-orchestrator/pending-list.md` の「切り出し」に従う。新規Issueの作成と、元になった `[保留]` コメントの削除は一続きの手順である。削除の可否を人間に諮らない（対象コメントが一意に特定できない場合だけ確認する）。

#### 1-[2/3] Issue本文テンプレート【必須】

Issueの本文骨格と起票前チェックは `{{SHARED_SKILLS_PATH}}/gh-maestro-orchestrator/issue-template.md` に従うこと。

#### 1-[3/3] 人間の承認とGitHubへの反映【必須】

**実装を指示するIssueは、時機を問わず起草案を提示し、チャット上で承認を得てからGitHubへ反映する。**

調査・architect相談を人間が依頼した場合、その依頼が調査アンカー作成の許可を兼ねる。調査アンカーは起草案提示・再承認なしで、タイトルだけのIssueとして作成できる。既存の調査アンカーがあれば要件を追記して使う。

実装Issueでは、調査アンカーとして使っていた既存Issueがあればそれを更新し、無ければ新規作成する。本文は「概要（人間向け）」のみで構成する。

Issue本文は必ず `write-draft.js` で論理パス（`/tmp/issue-<N>.md`）に書き出してから `--body-file` で渡す。`--body` へのインライン渡しは禁止（エスケープ問題が発生する）。実体パスを推論・抽出してはならない。Issue番号をファイル名に含めることで並列起票時の衝突を防ぐ。

```sh
node "{{SCRIPTS_PATH}}/write-draft.js" /tmp/issue-<N>.md --stdin <<'EOF'
<Issue本文>
EOF

# 新規作成 — 出力: ISSUE_CREATED:<番号> <URL>
node "{{SCRIPTS_PATH}}/create-issue.js" --title "<タイトル>" \
  --body-file /tmp/issue-<N>.md --repo $REPO --workspace $WORKSPACE --guidance-signal implementation-issue

# 既存Issueを実装指示に更新
node "{{SCRIPTS_PATH}}/update-issue.js" --issue <N> --title "<正式タイトル>" \
  --body-file /tmp/issue-<N>.md --repo $REPO --workspace $WORKSPACE --guidance-signal requirements-updated
```

`--workspace` は必ず明示する（省略するとIssue作成先のworkspaceがずれる）。assistantを起動する場合も同じworkspaceを指定する。

---
signals:
  - none
---
# 工程 1. 要件確定【必須】

このファイルは、同じIssueを担当するorchestratorが工程1で実行する手順の正本である。工程番号・必須／任意・入口／待機／遷移を確認して進める。人間への発言と工程横断の不変条件はSKILL.mdに従う。

<!-- gh-maestro-structure: middle-items=5 -->

入口: 人間から変更要望、または既存Issueの要件確定を依頼されたとき。待つもの: 要件・制約・対象外・受け入れ条件の人間による承認。次: 承認後に工程2。

人間と協働して対象 Issue を起草・作成し、目的・制約・対象外・受け入れ条件・既決事項・未決事項を Issue 本文で確定する。単独で要件を決めない。

確定したら「この Issue を渡されたコーダーが実装計画を立てられるか」を自問し、NO なら人間と要件を確認して修正する。

**実装詳細（変更方針・作業分割・実装者が選ぶ検証方法）は Issue 本文には書かない。** これらはコーダーが実装着手前の計画フェーズで作成し、計画として投稿する。Issue本文は「何を実現したいか」（目的・制約・対象外・受け入れ条件）に徹する。求める振る舞いと、その振る舞いを満たしたと判断するために必要な確認の結果は要件であり、受け入れ条件に含める。承認する計画が既存の受け入れ条件にない振る舞いや確認を約束している場合は、工程6で承認前に取り込む。ただし、問題が起きている場所の特定（ファイル名・パス・識別子）は実装詳細ではなく要件の一部である。一般名詞へ言い換えず、そのまま書く。

#### 1-[1/5] 保留Issueから切り出す場合【任意】

起票する内容が保留Issue（`gh-maestro-pending` ラベル）の項目に由来する場合は、`{{SHARED_SKILLS_PATH}}/gh-maestro-orchestrator/pending-list.md` の「切り出し」に従う。新規Issueの作成と、元になった `[保留]` コメントの削除は一続きの手順である。削除の可否を人間に諮らない（対象コメントが一意に特定できない場合だけ確認する）。

#### 1-[2/5] 直近Issueの同一領域確認【必須】

すべてのIssueで、起票前に対象プロジェクトの直近のIssueタイトルを確認する。orchestrator自身が、本文を取得せず次のように見出しだけを取得し、ワーカーを起動しない。

```sh
gh issue list --repo $REPO --state all --limit 30 --json number,title
```

タイトルから、同じ領域で手直しが続いているかを見る。バグの修正が続いている場合も含む。件数の閾値で機械的に判定しない。続いていれば、`{{SHARED_SKILLS_PATH}}/gh-maestro-orchestrator/premise-check.md`（共通の定義）と `{{SHARED_SKILLS_PATH}}/gh-maestro-orchestrator/premise-check-stage-1.md` にある場面の「同じ領域で手直しが続いている」に当たる。続いているIssueの番号を控えて1-[3/5]へ進む。

#### 1-[3/5] 仕組みの定石調査【任意】

`premise-check.md`（共通の定義）と `premise-check-stage-1.md` にある「疑いを向ける場面」に当たるかを判定する。1-[2/5]の結果も使う。

当たらないと判定したときは、その根拠を1-[5/5]で承認を求める提示の中で発言し、この中項目を終える。

当たるときは、要件の承認を求める前に、`premise-check-stage-1.md` にある4段の問いに答える。

1. **調査の要否を決める。** 1段目と2段目を書くために explorer の調査が要るかを判断する。
   - 要るときは、`premise-check.md` の共通原則と `premise-check-stage-1.md` にある「explorer への依頼」の形で依頼文を作り、調査したい根拠と依頼文を人間に示して許可を求める。許可を得てから explorer を1つ起動する。起動にはIssueアンカーが要るため、まだIssueが無ければ1-[5/5]の調査アンカーを先に作る。
   - 要らないときは、そのことと根拠を発言して進む。1段目と2段目は「調査なし」として分かる範囲だけを書く。
2. **4段に答え、Issueコメントに残す。** `premise-check.md` の共通書式と `premise-check-stage-1.md` にある書式で書き、`comment-issue.js` で対象Issueに投稿する。チャットには結論の1〜2文とコメントのURLだけを示す。Issueがまだ無い場合は、1-[5/5]でIssueを作成した直後、承認を求める前に投稿する。
3. **4段目の結果で分岐する。** 要求が成り立つなら、1-[4/5]へ進む。成り立たないなら、要件の承認へ進まず、人間にIssueの見直しを諮る。書き直すか、閉じるか、そのまま続けるかは人間が決める。

調査結果や4段の答えだけで要件を変更しない。要件の変更は人間と協働して行う。軽量PR経路は工程1を通らないため、この中項目の対象外である。

#### 1-[4/5] Issue本文テンプレート【必須】

Issueの本文骨格と起票前チェックは `{{SHARED_SKILLS_PATH}}/gh-maestro-orchestrator/issue-template.md` に従うこと。

#### 1-[5/5] 人間の承認とGitHubへの反映【必須】

**実装を指示するIssueは、先にGitHubへ作成し、そのURLを示して人間の承認を得る。** 下書きのファイルパスを人間に渡して読ませない。修正の指示を受けたら、同じIssueを `update-issue.js` で書き換え、再びURLを示す。承認を得るまで工程2以降へ進まない。

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

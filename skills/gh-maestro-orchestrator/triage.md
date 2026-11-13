---
signals:
  - notify:REVIEW_COMMENT
  - notify:PR_REVIEW
---
# レビューコメントのトリアージ手順（参照専用）

Review Manager の指摘は通知本文ではなく `node "{{SCRIPTS_PATH}}/read-review-findings.js" --pr <PR> --workspace $WORKSPACE` の全文を入力にする（通知本文は途中で切れうる。終了コード2・3は「指摘なし」ではないので原因を確認して進む）。

同じPRの Review Manager 指摘スレッドを次のコマンドで照合する。`finding` 番号は全文出力の通し番号に対応し、世代は `manager.json` バイト列マーカーで照合する。対応行が0件または複数ならトリアージを進めず、その事実を人間に示す。

```sh
node "{{SCRIPTS_PATH}}/review-threads.js" list \
  --pr <PR> --repo $REPO --workspace $WORKSPACE
```

`url` を返信先、`commentId` を返信先コメント、`threadId` を Resolve 対象にする。`isResolved` が true の指摘を未処理として実行しない。修正後の確認では `list --pr <PR> --repo $REPO` で過去世代を含むスレッドを取得する。

人間の決定なしに指摘を実行してはならない不変条件は SKILL.md 側にあり、このファイルは評価・提示・実行の手順だけを持つ。人間への提示・質問は SKILL.md「人間への発言の規範」に従う。

## 実害度スコア・対応コスト（全指摘に付け、決定後にスレッドへ記録）

| スコア | 意味 | 例 |
|---|---|---|
| 1 | 理論上のみ成立。現在の運用形態では絶対に到達しない前提 | 「攻撃者が信頼済みローカルworkspace configを改ざんできる」 |
| 2 | 極めて特殊な運用を仮定しないと発現しない（意図的な悪用・極端な規模・特殊環境が前提） | 「大量の偽skillキーを仕込まれるとDoSになる」 |
| 3 | 判断が割れる／根拠を確認できていない | 「この情報は既に別の場所（既存ログ・公開Issue等）に同じ範囲で公開済みでは？」が未確認 |
| 4 | 通常運用で実際に発生しうる。今回のコード変更で説明がつく | 典型的なnullチェック漏れ・エラーハンドリング欠落 |
| 5 | 明確かつ高い確率で発生する実害 | データ破損・認証バイパスが直接再現できる |

SUGGESTION には不採用時に何が起きるかを評価して付ける（多くは低いが、放置したときの帰結を人間が読めることに意味がある）。実害度は厳しめに付け、複合条件で起きる指摘や機能をさらに掘り下げる修正は低く付ける。対応コストが中以上なら実害度に見合うか確かめ、見合わなければ保留を推奨する。

| コスト | 判断基準 |
|---|---|
| 低 | 1箇所・数行以内、レビュアーの提案がそのまま採用可能、公開契約に影響しない |
| 中 | 複数箇所にまたがる、または軽微な設計判断を要する |
| 高 | 設計トレードオフがある、または影響範囲の見極めが必要 |

## 人間への提示（観点・スコアの値にかかわらず必ず行う）

推奨が「コーダーに修正依頼」か「保留Issueに積む」の指摘のうち、`premise-check.md`「工程7」の場面に当たる指摘が1件以上あれば、表を出す前に同節に従って答え（必要時は許可を求めず explorer へ1回依頼）を `comment-issue.js` で Issue に投稿する。無ければ投稿しない。

指摘は1件1行で1つの一覧テーブルにまとめ（個別テーブル不可）、1からの通し番号を振る。クラスタ化時は全 finding 番号とスレッドURLを列挙し、決定を各スレッドへ記録する。重要度（先頭ラベル 🔴BLOCKER/🟡MAJOR/🟢SUGGESTION）と観点（`skills/gh-maestro-reviewer/` 正本の語）は解釈・言い換えせずそのまま転記する。要約は2〜3文以内で本文をそのまま縮めず抽象度を上げて一読で分かる水準にし（成立条件も落とさず、原因詳細は findings 本文に譲る）、スコア・コストの理由は一言（15字程度）にする。

```
### PR #$PR — レビュー指摘

| # | 重要度 | 観点 | 対象 | 要約 | 返信先（finding番号・URL） | 実害度 | 対応コスト | 推奨 |
|---|---|---|---|---|---|---|---|---|
| 1 | <🔴BLOCKER/🟡MAJOR/🟢SUGGESTION> | <Review Managerが付けた観点> | <path>:<line またはファイル単位> | <要約（2〜3文以内）> | <finding N: URL。複数ならすべて列挙> | <N>/5 — <一言理由> | <低/中/高> — <一言理由> | <コーダーに修正依頼/無視/保留Issueに積む（該当時は「 — <対策>（<コメントURL>）」を添える。両方なら「＋」で併記）> |
```

表の「推奨」列には実行する対応（「コーダーに修正依頼」「無視」「保留Issueに積む」のいずれか、両方なら「コーダーに修正依頼＋保留Issueに積む」）を必ず書く。場面に当たる指摘では続けて「 — <対策（指摘の方向どおり／標準の手段への置き換え）>（<答えのコメントURL>）」を添える。「今回は指摘の方向どおりに直し、置き換えは保留Issueに積む」を推奨する場合は修正依頼と保留の両方を示し、承認後に両方を実行する。提示後、「推奨のとおりに進めてよいですか？」と末尾に1つだけ問い、承認時は推奨どおり、一部別指定はその番号のみ指定に従い残りは推奨どおりに実行する（問いの形は SKILL.md「人間への発言の規範」に従う）。

## 人間の回答に従った実行

決定が定まった指摘には必ず返信と必要な Resolve を行う（返信失敗時は Resolve しない。返信または Resolve 失敗時は指摘・操作・エラーを分けて人間に示す）。

```sh
node "{{SCRIPTS_PATH}}/write-draft.js" /tmp/review-thread-<N>.md --stdin <<'EOF'
決定: <人間が決めた対応>
推奨: <人間が推奨と違う対応を指定した場合のみ>
理由: <推奨どおりなら実害度・対応コストの理由。異なる対応なら人間の理由（未提示は「人間の指定」）。場面に当たった指摘は答えのコメントへのリンクも含め、答えそのものは書かない>
対応先: <対応先または「なし」>
EOF
node "{{SCRIPTS_PATH}}/review-threads.js" reply \
  --pr <PR> --repo $REPO --comment-id <commentId> --body-file /tmp/review-thread-<N>.md
```

- **無視**: 決定の返信が成功したら、`threadId` を `review-threads.js resolve` に渡して Resolve する。
- **保留Issueに積む**: `pending-list.md` に従い元スレッドURL入り行を共通Issueへ追記し、投稿コマンドが返したコメントURLを決定返信に書き、返信成功後に Resolve する。
- **コーダーに修正依頼**: Issueへ修正依頼を送り、そのIssueを対応先に記録する。依頼後に決定・理由・Issue番号と「修正push後にコミットSHAを返信してResolveする」ことを返信する（ここでは Resolve せず工程7-[4/6]で行う）。修正依頼と保留の両方を実行する場合は両方の対応先を記し、修正push後に Resolve する。

## 修正push後の返信

工程7-[4/6]で修正確認後、過去世代を含む一覧からトリアージ時のURL・findingマーカーに一致する元スレッドを1件に特定し、修正コミットSHAを返信する。返信成功を確認してから `resolve` を実行する（複数指摘を1コミットで直した場合は各スレッドへ同じSHAを返信）。一意に照合できない場合は Resolve しない。返信・Resolveの失敗は指摘・操作・理由を分けて人間に示し、commit・push・merge の機械停止条件にしない。

```sh
node "{{SCRIPTS_PATH}}/review-threads.js" list --pr <PR> --repo $REPO
node "{{SCRIPTS_PATH}}/write-draft.js" /tmp/review-fixed-<N>.md --stdin <<'EOF'
修正コミット: <SHA>
EOF
node "{{SCRIPTS_PATH}}/review-threads.js" reply \
  --pr <PR> --repo $REPO --comment-id <commentId> --body-file /tmp/review-fixed-<N>.md
node "{{SCRIPTS_PATH}}/review-threads.js" resolve --thread-id <threadId>
```

修正依頼は次のコマンドでIssueへ送り、上記の共通返信形式で依頼先を元スレッドへ記録する。複数の修正依頼は同じトリアージ内でまとめてよい。

```sh
node "{{SCRIPTS_PATH}}/msg-send.js" --issue <実装Issue> --skill gh-maestro-coder --workspace $WORKSPACE --stdin <<'EOF'
修正依頼: <path>:<line またはファイル単位> — <問題の説明>。<修正方針>。（PR #<PR番号> のレビュー指摘より）修正後は `push-and-declare.js` で push とテスト結果申告まで行い、完了したら即報告してください。
対応するレビュー: <thread URL>
EOF
# senior-coder を使っていた場合は --skill gh-maestro-senior-coder
```

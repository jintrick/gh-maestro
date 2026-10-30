---
signals:
  - notify:PR_MERGED
---
# 工程 8. 本番公開（CI/CD）確認【必須】

このファイルは、同じIssueを担当するorchestratorが工程8で実行する手順の正本である。工程番号・必須／任意・入口／待機／遷移を確認して進める。人間への発言と工程横断の不変条件はSKILL.mdに従う。

入口: PR_MERGEDを受けたとき、stage-9へ進む前に実施する。待つもの: CI/CD workflowの完了と、失敗時は人間の対応判断。次: 工程9。

## 8-[1/2] 実行確認と待機【必須】

マージ後のBASE_BRANCHを先に最新化し、直近のworkflowを確認する。

```sh
git -C "$WORKSPACE" pull --ff-only
gh run list --repo $REPO --branch $BASE_BRANCH --limit 1
```

`queued` / `in_progress` なら `gh run watch <run-id> --repo $REPO` で完了まで待つ。該当runがない場合は未設定と確認する。

## 8-[2/2] 結果と対応【必須】

- `success`: 結果を人間へ事実として伝え、工程9へ進む。
- `failure` / `cancelled` / `timed_out`: `gh run view <run-id> --repo $REPO --log-failed` で失敗概要を取得し、人間と対応を決めてから工程9へ進む。
- runなし: workflow未設定の事実を記録し、工程9へ進む。

この手順書は工程8で実行する内容の正本である。人間への発言はSKILL.md「人間への発言の規範」に従う。

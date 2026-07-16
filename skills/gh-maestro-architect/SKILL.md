---
name: gh-maestro-architect
description: 確定済み要件と圧縮済み調査コンテクストから、GitHub Issue に実装計画を残すオンデマンド設計ワーカー。
---

# gh-maestro Architect

このスキルは、確定済みの要件定義を満たすための実装計画を検討し、対象 Issue のコメントとして残す。

## 入力と境界

- `ISSUE` 環境変数で指定された GitHub Issue の本文にある要件定義と、起動プロンプトで渡された圧縮済み調査コンテクストだけを使う。
- 要件の採否・優先順位・実装開始・マージを判断しない。要件定義を変更しない。
- 自律的なリポジトリ探索、コード・テスト・設定・Issue・PR の変更を行わない。
- 情報不足または要件矛盾を見つけた場合は、根拠・影響・必要な質問または調査要求を実装計画と区別して示す。

## 成果物

結果は自由形式 Markdown で記述する。要件を満たす方針、重要な判断と代替案、変更領域と順序、リスク・未解決事項を、必要な粒度で説明する。

結果はローカルファイルを正本にせず、必ず対象 Issue へ直接コメントする。本文を一時ファイルに保存した後、次を実行する。

```sh
node "{{SCRIPTS_PATH}}/msg-send.js" "$WORKER_NAME" \
  --body-file <Markdownファイル> \
  --issue "$ISSUE" --workspace "$WORKSPACE" --from "$WORKER_NAME" \
  --raw --execution-id "$EXECUTION_ID"
```

`--raw` は自由形式 Markdown をそのままコメントにする。`--execution-id` は投稿成功時だけ実行記録を完了にする。同じ完了済み実行IDで再試行した場合、既存のコメントURLを返して重複投稿しない。

最初のコマンドが返したコメント URL を使い、次に既存のメッセージ経路で orchestrator へ通知する。設計 Markdown 本文やローカルファイルパスはメッセージに含めず、Issue 上のコメント URL だけを送る。

```sh
node "{{SCRIPTS_PATH}}/msg-send.js" orchestrator \
  "architect の設計コメントを投稿しました: <上で得たコメントURL>" \
  --issue "$ISSUE" --workspace "$WORKSPACE" --from "$WORKER_NAME"
```

この通知は既存の Issue コメント・メッセージマーカー・orchestrator inbox 監視で配送される。architect 自身は返答を待ち受けず、通知後に終了する。不足情報・要件矛盾を返した場合も同じであり、orchestrator が通知先のコメントを読み、調査または人間確認後に新しい実行として architect を再起動する。

コメント URL が得られた時だけ設計成果物の作業完了とする。投稿に失敗した場合は成功と報告せず、失敗をそのまま残す。通知に失敗した場合は、最初のコマンドを同じ実行IDで再実行して既存 URL を取得し、通知だけを再試行する。

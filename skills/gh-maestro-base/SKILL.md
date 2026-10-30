---
name: gh-maestro-base
description: gh-maestroワーカーの共通骨格テンプレート。orchestratorが動的にワーカーを生成する際のベースとして使用する。
---

{{COMMUNICATION_RULES}}

## 質問ターンの終了規約

- 実装中に判断が必要になったら、通信ルールの既存コマンド `node "{{SCRIPTS_PATH}}/msg-send.js" --body-file <質問本文ファイルのパス>` でorchestratorへ質問を投稿する。
- 質問の投稿が成功したら、そのターンで追加の調査・実装・計画・完了報告を続けず、ワーカー自身の手順を終了する。回答は次の resume で受け取る。

理由と経緯: `docs/adr/0027-question-is-turn-end-not-completion.md`

## 制約

- `npm install` / `npm ci` は実行しない。`node_modules` はシンボリックリンクで用意済み

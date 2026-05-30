# gh-maestro

GitHubをメッセージバス兼永続ストアとして、複数のAIエージェントを協調動作させるデーモン。Issue起票からPRマージまでを自動化する。

## アーキテクチャ

```
src/daemon.js          メインデーモン（30秒ポーリング）
tools/signal-daemon.js エージェントが完了時に呼ぶ即時ポーリング通知ラッパー
workers.json           ラベル → エージェントコマンドのマッピング
ecosystem.config.js    PM2設定（プロセス名: agent-runtime）
```

## 起動

```
# PM2で常駐（推奨）
npm run start:pm2

# 直接起動（開発用）
npm start
```

**前提**: `gh auth login` 済みであること。起動時に認証チェックを行い、失敗したら即終了する。

## ラベルフロー

```
awaiting-orchestrator → [オーケストレーター] → awaiting-approval
approved / rejected   → [オーケストレーター] → awaiting-coder
awaiting-coder        → [コーダー]           → awaiting-review
awaiting-review       → [レビュアー]         → awaiting-approval | awaiting-coder
```

デーモンが反応するラベル（workers.jsonのキー）にIssueが到達すると：
1. `in-progress` を即座に付与（二重起動防止）
2. 対応するコマンドを `GH_ISSUE=<番号>` 環境変数付きでspawn
3. 完了後に `in-progress` を除去
4. 異常終了時は `human-escalation` を付与

## 並列制御

**グローバルに1エージェントのみ**。`activeChild` が存在する間はポーリングをスキップ。

## エージェントへの情報渡し

エージェントは環境変数 `GH_ISSUE` から担当Issue番号を取得する。

## 即時ポーリング（エージェントからの通知）

エージェントはラベル更新後に `node tools/signal-daemon.js` を呼ぶことで、デーモンに30秒待たずに再ポーリングさせられる。OSごとの差異はこのスクリプトに閉じている（Windows: PM2 trigger, Linux: SIGUSR1）。

## workers.json の形式

```json
{
  "<trigger-label>": "<command>"
}
```

コマンドは `GH_ISSUE` 環境変数でIssue番号を受け取る前提で書く。

## 未決定事項

- `human-escalation` の通知手段（Windows通知 / Issueコメント / メール）
- 対象リポジトリの範囲（このリポジトリ専用 vs 複数リポジトリ対応）
- オーケストレーターのIssue分解粒度

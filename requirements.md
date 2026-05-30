# gh-maestro 要件定義書

v0.2 / 2026-05-30

---

## 1. 目的

GitHubをメッセージバス兼永続ストアとして、複数のAIエージェントを協調動作させる。人間の承認を要所に挟みながら、Issue起票からPRマージまでの開発タスクを自動化する。

---

## 2. 前提・制約

| 項目 | 決定事項 |
|---|---|
| 実行環境 | 当面は Windows（Windows 10）。将来的に Linux にも対応できる設計とする |
| エージェントCLI | Claude Code (`claude`) / Antigravity CLI (`agy`) |
| 並列実行 | Issue単位で直列のみ（同時に1タスク） |
| CI/CDとの関係 | 既存のGitHub Actionsと共存。エージェントはブランチへのpushのみ行う |

---

## 3. エージェントの役割定義

### 3.1 オーケストレーター

**責務**
- リポジトリの現状をGitHub CLI（`gh`）で把握する
- 何をすべきかを判断し、Issueを作成またはラベルを更新する
- 判断のみ行い、コードは書かない

**終了条件**
- `awaiting-approval` ラベルを付与してデーモンにシグナルを送り、終了する

**起動条件（ラベル）**
- `awaiting-orchestrator`：初回または差し戻し後の計画立案
- `approved`：人間が承認後、タスクをワーカーに割り当て

### 3.2 コーダーワーカー

**責務**
- 割り当てIssueを読んで実装する
- ビルド・テストを自分で実行し、失敗したら自己修正する（リトライ上限内）
- 完了したらPRを作成し、`awaiting-review` ラベルを付与して終了する

**終了条件（成功）**
- PRを作成し、`awaiting-review` ラベルを付与してデーモンにシグナルを送る

**終了条件（失敗）**
- リトライ上限（3回）を超えたら `human-escalation` ラベルを付与して停止する

**ブランチ規則**
- `dev` から切る
- ブランチ名: `<type>/<issue番号>-<概要>`（例: `feat/42-add-login`）
- `master`・`dev` への直接pushは禁止

### 3.3 レビュアーワーカー

**責務**
- PRのdiffとIssue要件を照合する
- レビューコメントを投稿する（修正は行わない）
- 問題なければ `awaiting-approval` ラベルを付与する（人間にマージ判断を委ねる）
- 修正が必要なら `awaiting-coder` ラベルを付与してコーダーに差し戻す

**起動条件（ラベル）**
- `awaiting-review`

---

## 4. 人間の介入ポイント

```
[人間] Issue を作成 / awaiting-orchestrator ラベルを付与
  ↓
[オーケストレーター] 計画立案
  ↓ awaiting-approval
[人間] 計画を承認 → approved ラベル  OR  却下 → rejected ラベル
  ↓ approved
[オーケストレーター] コーダーに割り当て
  ↓ awaiting-coder
[コーダー] 実装・PR作成
  ↓ awaiting-review
[レビュアー] レビューコメント
  ↓ awaiting-approval（問題なし） or awaiting-coder（差し戻し）
[人間] PRをdev にマージ  OR  差し戻し
```

人間が行う操作：
1. 初期Issueの起票（または `awaiting-orchestrator` ラベル付与）
2. 計画の承認（`approved`）または却下（`rejected`）
3. PRの最終マージ判断

---

## 5. ラベル仕様

| ラベル | 付与者 | 意味 | デーモンの反応 |
|---|---|---|---|
| `awaiting-orchestrator` | 人間 / レビュアー | オーケストレーター起動待ち | オーケストレーターを起動 |
| `awaiting-approval` | オーケストレーター / レビュアー | 人間の判断待ち | 何もしない |
| `approved` | 人間 | 承認済み | オーケストレーターを起動 |
| `rejected` | 人間 | 却下 | オーケストレーターを起動 |
| `awaiting-coder` | オーケストレーター / レビュアー | コーダー起動待ち | コーダーを起動 |
| `awaiting-review` | コーダー | レビュアー起動待ち | レビュアーを起動 |
| `in-progress` | デーモン | 実行中（二重起動防止） | 何もしない |
| `human-escalation` | エージェント | 人間対応が必要 | 何もしない（通知のみ） |
| `done` | レビュアー | 完了 | 何もしない |

---

## 6. デーモン仕様

### 6.1 基本動作

- Windows上で常駐（PM2またはタスクスケジューラ）
- 30秒間隔で `gh issue list` をポーリングし、ラベル差分を検出する
- エージェント完了時にシグナルを受け取り、即時ポーリングを実行する

### 6.2 即時トリガー（シグナル）

エージェント完了時にデーモンへ即時ポーリングを通知する。手段はOSによって異なるが、**エージェントが書くコードは共通のラッパーコマンドを呼ぶだけ**にし、OS分岐をデーモン側に閉じ込める。

| OS | 手段 | コマンド |
|---|---|---|
| Linux | `SIGUSR1` | `kill -SIGUSR1 <pid>` |
| Windows | PM2 trigger | `pm2 trigger agent-runtime poll` |

エージェントは `node tools/signal-daemon.js`（ラッパー）を呼ぶ。このスクリプトがOS判定して適切な手段を選ぶ。

### 6.3 競合制御

- ラベル検知時に即座に `in-progress` ラベルを付与してからエージェントをspawnする
- エージェント終了時に `in-progress` を除去する
- ポーリング時に `in-progress` が付いているIssueはスキップする

### 6.4 エラー処理

| 状況 | 挙動 |
|---|---|
| エージェントプロセスが異常終了 | `in-progress` を除去し、`human-escalation` を付与 |
| コーダーがリトライ上限超過 | コーダー自身が `human-escalation` を付与して終了 |
| gh CLI認証エラー | デーモン起動時にチェックし、失敗したら起動しない |

### 6.5 workers.json 形式

```json
{
  "awaiting-orchestrator": "agy run --skill orchestrator",
  "approved":              "agy run --skill orchestrator",
  "rejected":              "agy run --skill orchestrator",
  "awaiting-coder":        "claude --skill coder",
  "awaiting-review":       "claude --skill reviewer"
}
```

---

## 7. 未決定事項（次回確認）

| 項目 | 内容 |
|---|---|
| リトライ上限の具体的な値 | コーダーの自己修正は何回まで許容するか（仮: 3回） |
| `human-escalation` の通知手段 | Windows通知？Issueコメント？メール？ |
| デーモンの常駐手段 | PM2を第一候補とする（Windows/Linux共通で動作する。タスクスケジューラはPM2が使えない場合の代替） |
| 対象リポジトリの範囲 | このリポジトリ専用か、複数リポジトリに対応させるか |
| オーケストレーターのIssue分解粒度 | 1 Issue = 1 PR の原則を守るか、サブIssueに分解するか |

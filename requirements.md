# gh-maestro 要件定義書

v1.3 / 2026-06-01

---

## 1. 目的

GitHubを永続ストアとして使い、複数のAIエージェントを協調動作させる。Issue起票からPRマージまでの開発タスクを自動化する。

---

## 2. 前提・制約

| 項目 | 決定事項 |
|---|---|
| 実行環境 | Windows / Linux / macOS |
| ターミナル管理 | WezTerm（split pane） |
| エージェント間通信 | `wezterm cli send-text --pane-id <id> "メッセージ" && wezterm cli send-text --pane-id <id> --no-paste "\r"`（`send-pane.js` で抽象化） |
| wezterm 起動前提 | 起動スキルは wezterm 内（`WEZTERM_PANE` 環境変数あり）から実行すること |
| オーケストレーター | `/gh-maestro` スキルを呼び出したエージェント自身がオーケストレーターになる |
| ワーカー | agy（Antigravity CLI）等。スキルで動作定義するため実装は差し替え可能 |
| ワーカー構成 | orchestratorがタスクに応じて動的に決定（固定構成なし） |
| 並列実行 | orchestratorが判断して決定（直列・並列どちらも可） |
| ブランチ運用 | worktreeで `issue-<N>-<description>` ブランチを作成 → `dev→main` PR |
| CI/CDとの関係 | 既存のGitHub Actionsと共存。エージェントは `dev` への push のみ行う |
| インストーラー差分吸収 | OS差分はインストーラー（`.ps1` / `.sh`）のみで吸収。スキル・スクリプトはクロスプラットフォーム（Node.js / sh）で記述 |

### 対象プロジェクトの前提条件

gh-maestro を使用する対象プロジェクトは以下を満たすこと：

- `gh auth login` 済み（GitHub CLI 認証）
- `git remote` に `origin` が設定済み（GitHubリモートURL）
- `main` ブランチおよび `dev` ブランチが存在すること
- 実行環境が WezTerm ターミナル内であること（`WEZTERM_PANE` 環境変数がセットされていること）
- Node.js 18以上がインストールされていること

---

## 3. リポジトリ構成

```
gh-maestro/
├── gh-maestro-install.ps1      # グローバルインストーラー（Windows）
├── gh-maestro-install.sh       # グローバルインストーラー（Linux/macOS）
├── scripts/
│   └── gh-maestro-setup.js     # 前提条件チェック（起動スキルから呼び出し）
└── skills/
    ├── gh-maestro/
    │   └── SKILL.md            # 起動スキル
    ├── gh-maestro-orchestrator/
    │   ├── SKILL.md            # orchestratorスキル（ペイン操作 + ゴール定義）
    │   └── scripts/
    │       ├── send-pane.js    # 既存ペインへの送信
    │       └── spawn-worker.js # ワーカーペインの動的生成（--skill / --prompt）
    ├── gh-maestro-base/
    │   └── SKILL.md            # ワーカー共通骨格テンプレート
    ├── gh-maestro-coder/
    │   └── SKILL.md            # coderスキル（ゴール定義）
    └── gh-maestro-reviewer/
        └── SKILL.md            # reviewerスキル（ゴール定義）
```

**スキルのロード方法**: Claude Code・agy ともに同じ `SKILL.md` フォーマット（[Agent Skills](https://agentskills.io) オープンスタンダード）。インストーラーが両エージェントのグローバルスキルディレクトリに配置する。

**gh-maestroは対象プロジェクトの外に置く**。対象プロジェクトのワークスペースルートで起動スキルを呼び出す。

---

## 4. アーキテクチャ概要

### 4.1 二段階構成

**一回限りのインストール**
- スキルをエージェントのグローバルスキルディレクトリに配置する
- `gh-maestro-setup.js` を `~/.gh-maestro/scripts/` に配置する（`send-pane.js` はワーカー起動時にワークスペースへ自動配置）
- 以後、どのプロジェクトでも追加インストール不要

**プロジェクト起動（`/gh-maestro` スキル呼び出し）**
- 対象プロジェクトのワークスペースルートで、claudeまたはagyから `/gh-maestro` を呼び出す
- 前提条件チェック後、自身がorchestratorとして動作を開始する

### 4.2 エージェント配置（動的構成）

```
/gh-maestro スキル呼び出し（claude or agy）
  └─ 現在のペイン: orchestrator

orchestratorがタスクに応じてワーカーを動的生成:
  ├─ 新規ペイン: agy → coder（必要時に生成）
  └─ 新規ペイン: agy → reviewer（必要時に生成）
```

ワーカーの種類・数・レイアウトはorchestratorが判断して決定する。新しい役職はスキルファイルを追加するだけで対応可能。

### 4.3 起動スキルの動作

1. 前提条件チェック（wezterm・git・gh認証・dev/mainブランチ・WEZTERM_PANEの存在）
2. `gh-maestro-orchestrator` スキルのゴール定義に移行する

### 4.4 グローバルインストール先

| 種別 | Claude Code | agy |
|---|---|---|
| スキル | `~/.claude/skills/<skill-name>/` | `~/.gemini/antigravity/skills/<skill-name>/` |
| セットアップスクリプト | `~/.gh-maestro/scripts/gh-maestro-setup.js` | （共通） |

### 4.5 ペイン識別とA2A通信

- orchestratorは `$WEZTERM_PANE` から自身のpane-idを取得する
- `spawn-worker.js` がワーカー起動時に以下を行う：
  - `ORCHESTRATOR_PANE_ID` を初期プロンプトに埋め込む
  - `send-pane.js` をワークスペースの `.gh-maestro/scripts/` にコピーする
  - worktreeを `.gh-maestro/worktrees/issue-<N>-<description>/` に作成する
- ワーカーはworktree内をワークスペースとして動作し、他ワーカーのブランチ操作と独立する
- ワーカーはワークスペース内の `.gh-maestro/scripts/send-pane.js` を使ってorchestratorに報告する
- orchestratorは `${CLAUDE_SKILL_DIR}/scripts/send-pane.js` を使ってワーカーに送信する

### 4.6 通信レイヤー

| 通信 | 手段 |
|---|---|
| 人間 ↔ オーケストレーター | エージェントTUI（GitHub不使用） |
| オーケストレーター → GitHub | `gh issue create` |
| エージェント間 | `send-pane.js`（`wezterm cli send-text` を抽象化） |
| エージェント ↔ GitHub | `gh` CLI（PR作成・レビュー） |

---

## 5. エージェントの役割定義

### 5.1 オーケストレーター

動作は `gh-maestro-orchestrator` スキル（SKILL.md）で定義する。

**責務**
- 人間と対話してIssueの内容を共同起草する
- `gh issue create` でGitHubにIssueを作成する
- タスクに応じてワーカーペインを動的に生成する（`spawn-worker.js`）
- coderに実装指示を送信する
- coderから完了報告を受けたら、以下のいずれかを判断して実行する：
  - 自分でレビューする
  - reviewerを起動して委任する
  - 自分とreviewerで並列レビューする
- レビュー完了後、人間にマージを依頼する

### 5.2 コーダー（agy）

動作は `gh-maestro-coder` スキル（SKILL.md）で定義する。

**責務**
- orchestratorからの指示を受け取り、実装を開始する
- 割り当てられたworktree（`issue-<N>-<description>`ブランチ）上で作業する
- ビルド・テストを自己実行して修正する（リトライ上限内）
- `gh pr create --base dev` でPR作成（本文に `Closes #<N>`）
- `send-pane.js` を使ってorchestratorに「PR #N を作成しました」と報告する

**失敗時**
- リトライ上限を超えたら `human-escalation` ラベルをIssueに付与して停止し、orchestratorに報告する

### 5.3 レビュアー（agy）

動作は `gh-maestro-reviewer` スキル（SKILL.md）で定義する。

**責務**
- orchestratorからの依頼を受け取り、レビューを開始する
- PRのdiffとIssue要件を照合する
- 承認: `gh pr review --approve` を提出し、`send-pane.js` でorchestratorに完了を通知する
- 修正必要: 指摘内容をまとめて `send-pane.js` でorchestratorに報告する

**注意**: `gh pr review --request-changes` はPR作成者と同一GitHubアカウントでは使用不可。レビュアーはorchestratorへの報告で代替する。

---

## 6. ワークフロー

```
[人間] 一回限り: インストーラーを実行
  └─ スキルと共有スクリプトをグローバルインストール

[人間] プロジェクト起動: wezterm 内のワークスペースルートで /gh-maestro を呼び出す
  └─ 前提条件チェック → orchestratorとして動作開始

  [orchestrator] 人間と対話 → gh issue create
           │ spawn-worker.js でcoderペインを生成
           │ send-pane.js で実装指示
           ▼
       [coder] 実装（issue-<N>-<desc>ブランチ / worktree）→ gh pr create（issue-<N>-<desc>→dev）
           │ send-pane.js で完了報告
           ▼
       [orchestrator] レビュー方針を判断
           │
     ┌─────┴──────┬───────────┐
  自己レビュー  reviewer起動  並列
           │
     APPROVED or 修正指摘
           │
           ▼
       [orchestrator] → [人間] マージ依頼
```

---

## 6.5 対象プロジェクトに生成されるファイル

| ファイル/ディレクトリ | 生成タイミング | 内容 |
|---|---|---|
| `.gh-maestro/scripts/send-pane.js` | `spawn-worker.js` 実行時 | A2A送信ユーティリティ（ワーカーが使用） |
| `.gh-maestro/worktrees/issue-<N>-<desc>/` | `spawn-worker.js` 実行時 | ワーカー専用git worktree |

`.gh-maestro/` は初回ワーカー起動時（`spawn-worker.js`）に `.gitignore` へ自動追記される。
worktreeはワーカー完了後に `spawn-worker.js` が提供するクリーンアップ手順でorchestratorが削除する。

## 7. ラベル仕様

| ラベル | 付与者 | 意味 |
|---|---|---|
| `human-escalation` | ワーカー | 人間対応が必要 |

---

## 8. 人間の介入ポイント

1. インストーラーを一回だけ実行してグローバルインストールする
2. wezterm を起動し対象プロジェクトのルートに移動する
3. claudeまたはagyを起動して `/gh-maestro` を呼び出す
4. orchestratorと対話してIssueを起草・作成する
5. `APPROVED` になったPRを `main` にマージする

---

## 9. 未決定事項

| 項目 | 内容 |
|---|---|
| `human-escalation` の通知手段 | wezterm通知 / Issueコメント / メール |
| リトライ上限の値 | コーダーの自己修正は何回まで（仮: 3回） |
| ペインレイアウト | orchestratorがデフォルトで使うレイアウト定義 |
| worktreeクリーンアップのタイミング | PRマージ後 / orchestrator判断 |

# gh-maestro 要件定義書

v1.1 / 2026-05-31

---

## 1. 目的

GitHubを永続ストアとして使い、複数のAIエージェントを協調動作させる。Issue起票からPRマージまでの開発タスクを自動化する。

---

## 2. 前提・制約

| 項目 | 決定事項 |
|---|---|
| 実行環境 | Windows（Linux版は別途 `gh-maestro.sh` で対応） |
| ターミナル管理 | Windows: wmux（split pane） |
| エージェント間通信 | wmux `terminal_send` + `terminal_send_key(enter)`（実機確認済み） |
| wmux 起動前提 | 起動スキルは wmux ペイン内から実行すること。PID tree walking による workspace identity 解決が前提 |
| オーケストレーター | `/gh-maestro` スキルを呼び出したエージェント自身がオーケストレーターになる |
| ワーカー | agy（Antigravity CLI）等。スキルで動作定義するため実装は差し替え可能 |
| 並列実行 | Issue単位で直列のみ（同時に1タスク） |
| ブランチ運用 | `dev` で直接作業 → `dev→main` PR（フィーチャーブランチ不要） |
| CI/CDとの関係 | 既存のGitHub Actionsと共存。エージェントは `dev` への push のみ行う |

### 対象プロジェクトの前提条件

gh-maestro を使用する対象プロジェクトは以下を満たすこと：

- `gh auth login` 済み（GitHub CLI 認証）
- `git remote` に `origin` が設定済み（GitHubリモートURL）
- `main` ブランチおよび `dev` ブランチが存在すること

---

## 3. リポジトリ構成

```
gh-maestro/
├── gh-maestro-install.bat      # 一回限りのグローバルインストーラー
├── gh-maestro-install.ps1      # インストーラー本体（PowerShell）
└── skills/
    ├── gh-maestro/
    │   └── SKILL.md            # 起動スキル（claudeにもagyにも配置）
    ├── gh-maestro-orchestrator/
    │   └── SKILL.md            # orchestratorスキル（claudeにもagyにも配置）
    ├── gh-maestro-coder/
    │   └── SKILL.md            # coderスキル（claudeにもagyにも配置）
    └── gh-maestro-reviewer/
        └── SKILL.md            # reviewerスキル（claudeにもagyにも配置）
```

**スキルのロード方法**: Claude Code・agy ともに同じ `SKILL.md` フォーマット（[Agent Skills](https://agentskills.io) オープンスタンダード）。インストーラーが両エージェントのグローバルスキルディレクトリに配置する。

**gh-maestroは対象プロジェクトの外に置く**。対象プロジェクトのワークスペースルートで起動スキルを呼び出す。

---

## 4. アーキテクチャ概要

### 4.1 二段階構成

**一回限りのインストール（`gh-maestro-install.bat`）**
- スキルをエージェントのグローバルスキルディレクトリに配置する
- agy向けに wmux MCP をグローバル設定に書き込む
- 以後、どのプロジェクトでも追加インストール不要

**プロジェクト起動（`/gh-maestro` スキル呼び出し）**
- 対象プロジェクトのワークスペースルートで、claudeまたはagyから `/gh-maestro` を呼び出す
- wmuxペインを作成してワーカーエージェントを起動する
- 呼び出したエージェント自身がオーケストレーターとして動作する

### 4.2 エージェント配置

```
/gh-maestro スキル呼び出し（claude or agy）
  ├─ 現在のペイン: orchestrator（/gh-maestroを呼び出したエージェント）
  ├─ 新規ペイン: agy 起動 → coder（指示待機）
  └─ 新規ペイン: agy 起動 → reviewer（指示待機）
```

### 4.3 起動スキルの動作

1. 前提条件チェック（git、gh認証、dev/mainブランチ）
2. `.git/config` から `origin` のリモートURLを読み取り `owner/repo` を特定する
3. wmux Named Pipe RPC（`pane.split`）で2ペインを追加作成する
4. 各ペインのptyIdを取得する
5. 各ペインのシェルをワークスペースルートに `cd` させる
6. coder/reviewerペインで `agy` を起動し、初期プロンプトを送信する（ptyId埋め込み）
7. `.gh-maestro/session.json` にptyIdを書き込む
8. orchestratorスキル（`gh-maestro-orchestrator`）の動作に移行する

### 4.4 グローバルインストール先

| スキル | Claude Code | agy |
|---|---|---|
| `gh-maestro`（起動） | `~/.claude/skills/gh-maestro/` | `~/.gemini/antigravity/skills/gh-maestro/` |
| `gh-maestro-orchestrator` | `~/.claude/skills/gh-maestro-orchestrator/` | `~/.gemini/antigravity/skills/gh-maestro-orchestrator/` |
| `gh-maestro-coder` | `~/.claude/skills/gh-maestro-coder/` | `~/.gemini/antigravity/skills/gh-maestro-coder/` |
| `gh-maestro-reviewer` | `~/.claude/skills/gh-maestro-reviewer/` | `~/.gemini/antigravity/skills/gh-maestro-reviewer/` |

agy向け wmux MCP グローバル設定（`~/.gemini/antigravity/mcp_config.json`）：

```json
{
  "mcpServers": {
    "wmux": {
      "command": "wmux",
      "args": ["mcp"]
    }
  }
}
```

Claude Codeはwmux MCPが自動登録されるため追加設定不要。

### 4.5 ペイン識別とA2A通信

- 起動スキルがペイン作成時にptyIdを取得し、各エージェントの初期プロンプトに埋め込む
- orchestratorは `.gh-maestro/session.json` からptyIdを読み込む（動的インジェクション）
- coder/reviewerは起動時の初期プロンプトに含まれるptyIdを使用する

### 4.6 対象プロジェクトに生成されるファイル

| ファイル | 内容 |
|---|---|
| `.gh-maestro/session.json` | PTY IDセッション情報（自動生成） |

スキルはグローバルインストール済みのため、対象プロジェクトへのコピーは不要。

`.gitignore` に `.gh-maestro/` を追加することを推奨。

### 4.7 通信レイヤー

| 通信 | 手段 |
|---|---|
| 人間 ↔ オーケストレーター | エージェントTUI（GitHub不使用） |
| オーケストレーター → GitHub | `gh issue create` |
| エージェント間 | `terminal_send(ptyId)` + `terminal_send_key(enter)` |
| エージェント ↔ GitHub | `gh` CLI（PR作成・レビュー） |

---

## 5. エージェントの役割定義

### 5.1 オーケストレーター

動作は `gh-maestro-orchestrator` スキル（SKILL.md）で定義する。グローバルインストール済みのため自動ロードされる。

**責務**
- 人間と対話してIssueの内容を共同起草する
- `gh issue create` でGitHubにIssueを作成する
- coderペインに「Issue #N を実装してください」と送信する
- coderから完了報告を受けたら、以下のいずれかを判断して実行する：
  - 自分でレビューする
  - reviewerに転送する
  - 自分とreviewerで並列レビューする
- レビュー完了後、人間にマージを依頼する

### 5.2 コーダー（agy）

動作は `gh-maestro-coder` スキル（SKILL.md）で定義する。

**責務**
- orchestratorからの指示を受け取り、実装を開始する
- `dev` ブランチ上で作業する
- ビルド・テストを自己実行して修正する（リトライ上限内）
- `gh pr create --base main` でPR作成（本文に `Closes #<N>`）
- orchestratorに「PR #N を作成しました」と報告する

**失敗時**
- リトライ上限を超えたら `human-escalation` ラベルをIssueに付与して停止し、orchestratorに報告する

### 5.3 レビュアー（agy）

動作は `gh-maestro-reviewer` スキル（SKILL.md）で定義する。

**責務**
- orchestratorからの依頼を受け取り、レビューを開始する
- PRのdiffとIssue要件を照合する
- 承認: `gh pr review --approve` を提出し、orchestratorに完了を通知する
- 修正必要: 指摘内容をまとめてorchestratorに報告する

**注意**: `gh pr review --request-changes` はPR作成者と同一GitHubアカウントでは使用不可。レビュアーはorchestratorへの報告で代替する。

---

## 6. ワークフロー

```
[人間] 一回限り: gh-maestro-install.bat を実行
  └─ スキル・MCP設定をグローバルインストール

[人間] プロジェクト起動: 対象プロジェクトのワークスペースルートで /gh-maestro を呼び出す
  ├─ 前提条件チェック
  ├─ 2ペイン追加作成（ptyId取得）
  ├─ coder/reviewer 起動（初期プロンプト送信）
  └─ session.json 書き込み

  [orchestrator] 人間と対話 → gh issue create
           │ terminal_send(coder_pty_id)
           ▼
       [coder] 実装（devブランチ）→ gh pr create（dev→main）
           │ terminal_send(orchestrator_pty_id)
           ▼
       [orchestrator] レビュー方針を判断
           │
     ┌─────┴──────┬───────────┐
  自己レビュー  reviewer委任  並列
           │
     APPROVED or 修正指摘
           │ terminal_send(orchestrator_pty_id)
           ▼
       [orchestrator] → [人間] マージ依頼
                    or → terminal_send(coder_pty_id) 修正指示
```

---

## 7. ラベル仕様

| ラベル | 付与者 | 意味 |
|---|---|---|
| `human-escalation` | ワーカー | 人間対応が必要 |

---

## 8. 人間の介入ポイント

1. `gh-maestro-install.bat` を一回だけ実行してグローバルインストールする
2. wmuxペイン内で対象プロジェクトのルートに移動する
3. claudeまたはagyを起動して `/gh-maestro` を呼び出す
4. orchestratorと対話してIssueを起草・作成する
5. `APPROVED` になったPRを `main` にマージする

---

## 9. 未決定事項

| 項目 | 内容 |
|---|---|
| `human-escalation` の通知手段 | wmux通知 / Issueコメント / メール |
| リトライ上限の値 | コーダーの自己修正は何回まで（仮: 3回） |
| 直列制御 | 複数Issueが存在する場合にcoderが1件に絞る仕組み |
| Named Pipe RPC実装 | 起動スキルからのペイン作成・ptyId取得の実装方法詳細 |
| `~/.gemini/antigravity/mcp_config.json` の競合 | 既存設定とのマージ方針 |
| Linux対応 | `gh-maestro-install.sh` + `~/.config/antigravity/skills/` など |

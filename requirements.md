# gh-maestro 要件定義書

v1.0 / 2026-05-31

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
| wmux 起動前提 | `gh-maestro.bat` は wmux ペイン内から実行すること。PID tree walking による workspace identity 解決が前提 |
| オーケストレーター | Claude Code CLI（`claude`）をTUIで対話的に起動 |
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
├── gh-maestro.bat          # Windowsスタートアップスクリプト
├── gh-maestro.sh           # Linux版（将来対応）
└── skills/
    ├── gh-maestro-orchestrator/
    │   └── SKILL.md        # orchestratorスキル（初期プロンプト経由で参照）
    ├── gh-maestro-coder/
    │   └── SKILL.md        # agy用スキル（自動ロード）
    └── gh-maestro-reviewer/
        └── SKILL.md        # agy用スキル（自動ロード）
```

**スキルのロード方法**: Claude Code・agy ともに同じ `SKILL.md` フォーマット（[Agent Skills](https://agentskills.io) オープンスタンダード）。配置先のみ異なる：
- orchestrator（Claude Code）: `.claude/skills/` → 自動ロード
- coder/reviewer（agy）: `.agents/skills/` → 自動ロード

**gh-maestroは対象プロジェクトの外に置く**。対象プロジェクトのワークスペースルートで `gh-maestro.bat` を実行する。

---

## 4. アーキテクチャ概要

`gh-maestro.bat` をワークスペースルートで実行すると、wmux上に3ペインが作成され、各エージェントが初期プロンプト付きで起動する。

エージェント間のハンドオフは `terminal_send` + `terminal_send_key(enter)` で行う。受信側TUIはアイドル状態で入力待ちになっているため、テキスト注入のみで起動する。

### 起動スクリプトの動作

1. `.git/config` から `origin` のリモートURLを読み取り `owner/repo` を特定する
2. 対象ワークスペースの初期化を行う：
   a. `skills/` をエージェント種別に応じた配置先へコピーする
      - `gh-maestro-orchestrator` → `.claude/skills/`（Claude Code用）
      - `gh-maestro-coder`, `gh-maestro-reviewer` → `.agents/skills/`（agy用）
      - 将来他のエージェントを追加する場合はここに配置ロジックを足す
   b. `.agents/mcp_config.json` に wmux MCP サーバー設定を書き込む（agy が `terminal_send` を使えるようにするため）
3. wmux Named Pipe RPC（`pane.split`）で3ペインを作成する
4. 各ペイン作成後に `surface_list` 相当のRPCでptyIdを取得する
5. 各ペインのシェルをワークスペースルートに `cd` させる（新規ペインはwmuxデフォルトCWDで起動するため）
6. 各エージェントを初期プロンプト付きで起動する。プロンプトには以下を含める：
   - 対象リポジトリ（`owner/repo`）
   - 自分の役割とスキル名
   - 他エージェントのptyId（A2A送信先として使用）

```
gh-maestro.bat（ワークスペースルートで実行）
  ├─ ペイン1: claude 起動 → orchestrator（人間との対話TUI）
  ├─ ペイン2: agy 起動   → coder（指示待機）
  └─ ペイン3: agy 起動   → reviewer（指示待機）
```

### ワークスペース初期化ファイル

`gh-maestro.bat` が対象ワークスペースに書き込むファイル：

| ファイル | 内容 |
|---|---|
| `.claude/skills/gh-maestro-orchestrator/SKILL.md` | orchestratorスキル（Claude Code用、自動ロード） |
| `.agents/skills/gh-maestro-coder/SKILL.md` | coderスキル（agy用、自動ロード） |
| `.agents/skills/gh-maestro-reviewer/SKILL.md` | reviewerスキル（agy用、自動ロード） |
| `.agents/mcp_config.json` | wmux MCPサーバー設定（マージ） |

`.agents/mcp_config.json` への追記内容：

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

### ペイン識別とA2A通信

- `gh-maestro.bat` がペイン作成時にptyIdを取得し、各エージェントの初期プロンプトに埋め込む
- orchestrator（Claude Code）は wmux MCP 自動登録済みのため追加設定不要
- coder/reviewer（agy）は `.agents/mcp_config.json` の wmux MCP設定を通じて `terminal_send` を使用する

### 通信レイヤー

| 通信 | 手段 |
|---|---|
| 人間 ↔ オーケストレーター | Claude Code CLI TUI（GitHub不使用） |
| オーケストレーター → GitHub | `gh issue create` |
| エージェント間 | `terminal_send(ptyId)` + `terminal_send_key(enter)` |
| エージェント ↔ GitHub | `gh` CLI（PR作成・レビュー） |

---

## 5. エージェントの役割定義

### 5.1 オーケストレーター（Claude Code）

動作は `gh-maestro-orchestrator` スキル（SKILL.md）で定義する。`.claude/skills/` に配置することで自動ロードされる。

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
[人間] gh-maestro.bat を実行
  │
  ├─ ワークスペース初期化（スキルコピー + mcp_config書き込み）
  ├─ 3ペイン作成（ptyId取得 → 初期プロンプトに埋め込み）
  │
  └─ [orchestrator] 人間と対話 → gh issue create
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

1. wmuxペイン内で `gh-maestro.bat` をワークスペースルートで実行する
2. orchestratorと対話してIssueを起草・作成する
3. `APPROVED` になったPRを `main` にマージする

---

## 9. 未決定事項

| 項目 | 内容 |
|---|---|
| `human-escalation` の通知手段 | wmux通知 / Issueコメント / メール |
| リトライ上限の値 | コーダーの自己修正は何回まで（仮: 3回） |
| 直列制御 | 複数Issueが存在する場合にcoderが1件に絞る仕組み |
| Named Pipe RPC実装 | `gh-maestro.bat` からのペイン作成・ptyId取得の実装方法詳細 |
| `.agents/mcp_config.json` の競合 | 既存設定とのマージ方針 |

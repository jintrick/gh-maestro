# gh-maestro

GitHubを永続ストアとして、複数のAIエージェントを協調動作させるオーケストレーションシステム。Issue起票からPRマージまでの開発サイクルを自動化する。

## アーキテクチャ

```
orchestrator (claude or agy)
    ↕ 人間と対話
    → Issue作成 (gh issue create)
    → ワーカーを動的にペイン生成 (spawn-worker.js)
    → A2A送信 (send-pane.js)

coder (agy) ※orchestratorが必要時に起動
    ← 指示受信
    → 実装 ($BASE_BRANCHブランチ)
    → PR作成 (gh pr create --base $BASE_BRANCH)
    → A2A送信 (完了報告)

reviewer (agy) ※orchestratorが必要時に起動
    ← レビュー依頼受信
    → レビュー (gh pr review)
    → A2A送信 (結果報告)
```

ワーカー（coder / reviewer）の構成と数はタスクに応じてorchestratorが動的に決定する。

## リポジトリ構成

```
gh-maestro/
├── gh-maestro-install.ps1      # グローバルインストーラー（Windows）
├── gh-maestro-install.sh       # グローバルインストーラー（Linux/macOS）
├── scripts/
│   └── gh-maestro-setup.js     # 前提条件チェック（起動スキルから呼び出し）
├── skills/
│   ├── gh-maestro/             # 起動スキル（/gh-maestro）
│   ├── gh-maestro-orchestrator/ # orchestratorスキル + アセットスクリプト
│   │   └── scripts/
│   │       ├── get-context.js  # REPO・WORKSPACEを取得
│   │       ├── send-pane.js    # ワーカー名でメッセージを送信
│   │       ├── spawn-worker.js # ワーカーペインの動的生成
│   │       └── remove-worker.js # ワーカー終了・worktree削除
│   ├── gh-maestro-coder/       # coderスキル（役職定義のみ）
│   └── gh-maestro-reviewer/    # reviewerスキル（役職定義のみ）
└── docs/rag/
    ├── claude-code/            # Claude Code RAGドキュメント
    ├── antigravity/            # agy RAGドキュメント
    └── wmux/                   # wezterm RAGドキュメント
```

インストーラーが `~/.gh-maestro/scripts/` に配置するスクリプト：
- `gh-maestro-setup.js` — 前提条件チェック

## 前提条件

| 項目 | 要件 |
|---|---|
| OS | Windows / Linux / macOS |
| ターミナル | [WezTerm](https://wezfurlong.org/wezterm/)（`WEZTERM_PANE` 環境変数が必要） |
| ランタイム | Node.js 18以上 |
| CLI | `claude`（Claude Code）または `agy`（Antigravity CLI）、`gh`（GitHub CLI） |
| GitHub | `gh auth login` 済み |
| リポジトリ | `origin` リモートが GitHub を向いていること、`main` / `dev` ブランチが存在すること |

## インストール（一回限り）

gh-maestroを任意の場所にクローンする（対象プロジェクトとは別の場所）:

```sh
git clone https://github.com/jintrick/gh-maestro.git
```

インストーラーを実行する（一回のみ。更新時も再実行）:

```sh
# Windows
.\gh-maestro-install.ps1

# Linux / macOS
chmod +x gh-maestro-install.sh
./gh-maestro-install.sh
```

インストーラーが自動で以下を行う：

1. スキルを `~/.claude/skills/` および `~/.gemini/antigravity/skills/` に配置
2. `gh-maestro-setup.js` を `~/.gh-maestro/scripts/` に配置（`send-pane.js` はワーカー起動時にワークスペースへ自動配置）

## 使い方

### 1. WezTermを起動してプロジェクトに移動する

WezTermのペイン内で対象プロジェクトのルートに移動する。

### 2. `/gh-maestro` を呼び出す

claude または agy を起動し、スキルを呼び出す：

```
/gh-maestro
```

スキルが自動で以下を行う：

1. 前提条件チェック（WezTerm環境・git・gh認証・devブランチ）
2. 自身がorchestratorとして動作を開始

### 3. orchestratorと対話する

Issueの内容を話し合って起票する。orchestratorがタスクに応じて必要なワーカーを起動する。

```
人間: 「ログイン機能を追加したい」
orchestrator: Issue起草・作成
orchestrator → coder起動: 「Issue #N を実装してください」
coder: 実装 → PR作成
coder → orchestrator: 「PR #M を作成しました」
orchestrator: レビュー判断（自己 or reviewer起動して委任 or 並列）
orchestrator → 人間: 「PR #M がAPPROVEDです。devへのマージをお願いします」
```

### 4. マージする

ワーカーが作成するPRは `issue-<N>-<desc>` → `$BASE_BRANCH` に向いている（`$BASE_BRANCH` はセッション起動時の作業ブランチ）。承認されたら GitHub 上でマージする。`main` へのマージは別途判断して行う。

## ワークフロー詳細

`requirements.md` を参照。

## 対象プロジェクトに生成されるファイル

```
.gh-maestro/
├── scripts/
│   └── send-pane.js              # ワーカー起動時に自動配置（A2A送信ユーティリティ）
├── workers.json                  # ワーカー名→pane-idマッピング（spawn-worker.jsが管理）
└── worktrees/
    └── issue-<N>-<desc>/         # ワーカー専用git worktree（ワーカー起動時に自動作成）
```

`.gh-maestro/` は初回ワーカー起動時に `.gitignore` へ自動追記される。

## スキルのカスタマイズ

`skills/` 以下の `SKILL.md` を編集してインストーラーを再実行すると更新が反映される。新しいワーカー役職を追加する場合は `skills/` に新しいスキルディレクトリを追加してインストールするだけでよい。


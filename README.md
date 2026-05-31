# gh-maestro

GitHubを永続ストアとして、複数のAIエージェントを協調動作させるオーケストレーションシステム。Issue起票からPRマージまでの開発サイクルを自動化する。

## 構成

```
orchestrator (Claude Code TUI)
    ↕ 人間と対話
    → Issue作成 (gh issue create)
    → A2A送信 (wmux terminal_send)

coder (agy)
    ← A2A受信
    → 実装 (devブランチ)
    → PR作成 (gh pr create)
    → A2A送信 (完了報告)

reviewer (agy)
    ← A2A受信 (optional)
    → レビュー (gh pr review)
    → A2A送信 (結果報告)
```

## 前提条件

| 項目 | 要件 |
|---|---|
| OS | Windows 10/11 |
| ターミナル | [wmux](https://github.com/openwong2kim/wmux) |
| CLI | `claude`（Claude Code）、`agy`（Antigravity CLI）、`gh`（GitHub CLI） |
| GitHub | `gh auth login` 済み |
| リポジトリ | `origin` リモートが GitHub を向いていること |

## インストール

gh-maestroを任意の場所にクローンする（対象プロジェクトとは別の場所）:

```powershell
git clone https://github.com/jintrick/gh-maestro.git
```

`gh-maestro.bat` にパスを通すか、フルパスで呼び出す。

## 使い方

### 1. wmux を起動する

wmux を起動してペインを用意する。`gh-maestro.bat` は自動でペインを分割するが、手動で3ペイン作っておいても動作する。

### 2. 対象プロジェクトのルートで実行する

```powershell
cd C:\your-project
C:\path\to\gh-maestro\gh-maestro.bat
```

スクリプトが自動で以下を行う：

1. 前提条件チェック（git、gh認証、devブランチ）
2. スキルのインストール（`.claude/skills/`、`.agents/skills/`）
3. agy向け wmux MCP 設定（`.agents/mcp_config.json`）
4. wmux ペイン3枚の準備とPTY ID取得
5. coder/reviewer（agy）を起動して初期プロンプト送信
6. orchestrator（claude）をTUIで起動

### 3. orchestratorと対話する

Claude Code TUIが起動したら、Issueの内容を話し合って起票する。以後は自動で流れる。

```
人間: 「ログイン機能を追加したい。...」
orchestrator: Issue起草・作成
orchestrator → coder: 「Issue #N を実装してください」
coder: 実装 → PR作成
coder → orchestrator: 「PR #M を作成しました」
orchestrator: レビュー判断（自己 or reviewer委任 or 並列）
orchestrator → 人間: 「PR #M がAPPROVEDです。mainへのマージをお願いします」
```

### 4. マージする

PRが承認されたら GitHub 上で `main` にマージする。

## ワークフロー詳細

`requirements.md` を参照。

## 対象プロジェクトに生成されるファイル

```
.claude/skills/gh-maestro-orchestrator/   # orchestratorスキル
.agents/skills/gh-maestro-coder/          # coderスキル
.agents/skills/gh-maestro-reviewer/       # reviewerスキル
.agents/mcp_config.json                   # agy wmux MCP設定（マージ）
.gh-maestro/session.json                  # PTY IDセッション情報（自動生成）
```

`.gitignore` に `.gh-maestro/` を追加することを推奨。

## スキルのカスタマイズ

`skills/` 以下の `SKILL.md` を編集することでエージェントの動作をカスタマイズできる。変更は次回 `gh-maestro.bat` 実行時に対象ワークスペースへ反映される。

## トラブルシューティング

**「wmux pipe-token not found」と表示される**
wmuxが起動していないか、wmuxペイン外から実行している。wmuxペイン内で実行すること。

**「Need 3 panes」エラーが出てpane.splitが失敗する**
wmux Named Pipe経由でのペイン分割に失敗している。wmuxをキーボードショートカットで手動で3ペインに分割してから再実行する。

**agyCLIが起動しない**
`agy` がPATHに通っていない。`agy --help` が動作することを確認する。

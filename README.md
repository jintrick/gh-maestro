# gh-maestro

GitHubを永続ストアとして、複数のAIエージェントを協調動作させるオーケストレーションシステム。Issue起票からPRマージまでの開発サイクルを自動化する。

## 構成

```
orchestrator (claude or agy)
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
| CLI | `claude`（Claude Code）または `agy`（Antigravity CLI）、`gh`（GitHub CLI） |
| GitHub | `gh auth login` 済み |
| リポジトリ | `origin` リモートが GitHub を向いていること |

## インストール（一回限り）

gh-maestroを任意の場所にクローンする（対象プロジェクトとは別の場所）:

```powershell
git clone https://github.com/jintrick/gh-maestro.git
```

インストーラーを実行する（一回のみ。更新時も再実行）:

```powershell
C:\path\to\gh-maestro\gh-maestro-install.bat
```

インストーラーが自動で以下を行う：

1. スキル（`gh-maestro`・`gh-maestro-orchestrator`・`gh-maestro-coder`・`gh-maestro-reviewer`）を `~\.claude\skills\` および `~\.gemini\antigravity\skills\` に配置
2. セットアップスクリプトを `~\.gh-maestro\scripts\` に配置
3. agy向け wmux MCP 設定を `~\.gemini\antigravity\mcp_config.json` に書き込み

## 使い方

### 1. wmux を起動してプロジェクトに移動する

wmux を起動し、対象プロジェクトのルートに移動する。`/gh-maestro` は自動でペインを分割するが、手動で3ペイン作っておいても動作する。

### 2. `/gh-maestro` を呼び出す

claude または agy を起動し、スキルを呼び出す：

```
/gh-maestro
```

スキルが自動で以下を行う：

1. 前提条件チェック（git、gh認証、devブランチ）
2. wmux ペイン2枚の追加作成とPTY ID取得
3. coder/reviewer（agy）を起動して初期プロンプト送信
4. `.gh-maestro/session.json` にPTY IDを保存
5. 自身がorchestratorとして動作を開始

### 3. orchestratorと対話する

スキル起動後、Issueの内容を話し合って起票する。以後は自動で流れる。

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
.gh-maestro/session.json    # PTY IDセッション情報（自動生成）
```

スキルはグローバルインストール済みのため、対象プロジェクトへのコピーは不要。

`.gitignore` に `.gh-maestro/` を追加することを推奨。

## スキルのカスタマイズ

gh-maestro リポジトリの `skills/` 以下の `SKILL.md` を編集し、`gh-maestro-install.bat` を再実行すると更新が反映される。

## トラブルシューティング

**「wmux pipe-token not found」と表示される**
wmuxが起動していないか、wmuxペイン外から実行している。wmuxペイン内で `/gh-maestro` を呼び出すこと。

**「pane.split failed」エラーが出る**
wmux Named Pipe経由でのペイン分割に失敗している。wmuxをキーボードショートカットで手動で3ペインに分割してから再試行する。

**agyCLIが起動しない**
`agy` がPATHに通っていない。`agy --help` が動作することを確認する。

**既存セッションに再アタッチしたい**
`.gh-maestro/session.json` が残っていれば、claude/agy を起動して `/gh-maestro-orchestrator` を呼び出すと既存セッションに接続できる。

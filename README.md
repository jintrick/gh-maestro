# gh-maestro

GitHubを永続ストアとして、複数のAIエージェントを協調動作させるオーケストレーションシステム。Issue起票からPRマージまでの開発サイクルを自動化する。

## 前提条件

| 項目 | 要件 |
|---|---|
| OS | Windows / Linux / macOS |
| ターミナル | [WezTerm](https://wezfurlong.org/wezterm/) |
| ランタイム | Node.js 18以上 |
| AIエージェント | `claude`（Claude Code）または `agy`（Antigravity CLI） |
| GitHub CLI | `gh`（`gh auth login` 済み） |
| リポジトリ | `origin` リモートが GitHub を向いていること |

## インストール

gh-maestro を任意の場所にクローンする（対象プロジェクトとは別の場所）：

```sh
git clone https://github.com/jintrick/gh-maestro.git
cd gh-maestro
```

インストーラーを実行する（一回のみ。更新時も再実行）：

```sh
# Windows
.\gh-maestro-install.ps1

# Linux / macOS
chmod +x gh-maestro-install.sh
./gh-maestro-install.sh
```

## 使い方

1. WezTerm 内で対象プロジェクトのルートに移動する
2. `claude` または `agy` を起動する
3. `/gh-maestro` を入力する

あとは orchestrator の指示に従って開発を進める。

```
あなた: 「ログイン機能を追加したい」
orchestrator: Issue を起草・作成
orchestrator → coder 起動・実装 → PR 作成
orchestrator → reviewer 起動・レビュー → あなたにマージを依頼
```

## 詳細仕様

`requirements.md` を参照。

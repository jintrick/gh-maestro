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
# 機能追加の場合
あなた: 「ログイン機能を追加したい」
orchestrator: Issue を起草・作成
orchestrator → coder 起動・実装 → PR 作成
orchestrator → reviewer 起動・レビュー → あなたにマージを依頼

# バグ調査の場合
あなた: 「Issue #12 のバグを調査してほしい」
orchestrator → investigator 起動・根本原因/影響範囲/修正方針を報告
orchestrator: 調査結果をあなたに提示 → 対応方針を判断
```

## スキルの構造

スキルは `skills/` 配下に1ディレクトリ1スキルで管理する。

```
skills/
  agents.yaml                    # エージェント定義（インストール先・プレースホルダー値）
  gh-maestro-orchestrator/
    SKILL.md                     # テンプレート（{{SCRIPTS_PATH}} を使用）
    scripts/                     # 共通アセット
  gh-maestro-coder/
    SKILL.md
    scripts/
  ...
```

`agents.yaml` にエージェントごとのインストール先とプレースホルダー置換値を定義する。インストール時に `SKILL.md` の `{{SCRIPTS_PATH}}` が各エージェント向けの値に置換され、インストール先に配置される。

**新スキルの追加**: `skills/` 配下にディレクトリを作成して `SKILL.md` を置く。次回インストール時に自動で全エージェントへ配布される。

**新エージェントの追加**: `agents.yaml` にエントリを追加してインストールスクリプトを再実行する。

## レビューポリシー

インストール時に Google Engineering Practices をベースにしたデフォルトのレビューポリシーが `~/.gh-maestro/review-policy.md` に配置される。レビュワーはこれを自動的に参照してPRを評価する。

プロジェクト固有の基準を追加したい場合は、対象プロジェクトのルートに `.gh-maestro/review-policy.md` を作成する。レビュワーはグローバルポリシーに加えてプロジェクトポリシーも参照する。

```
~/.gh-maestro/review-policy.md       # デフォルト（gh-maestroが提供・更新時に上書き）
<project>/.gh-maestro/review-policy.md  # プロジェクト固有（任意・リポジトリで共有可）
```

## 詳細仕様

`requirements.md` を参照。

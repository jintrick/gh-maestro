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
node scripts/install.js
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
CI: AI Code Review が自動実行（正確性・保守性・堅牢性）
orchestrator: レビュー結果をトリアージ → あなたにマージを依頼

# バグ調査の場合
あなた: 「Issue #12 のバグを調査してほしい」
orchestrator → investigator 起動・根本原因/影響範囲/修正方針を報告
orchestrator: 調査結果をあなたに提示 → 対応方針を判断
```

## AI Code Review CI

PR作成時に単一のAIレビュワー `reviewer` が GitHub Actions 上で自動実行され、3観点を独立してレビューし観点ごとに別々のレビューを投稿する。

| 観点 | 内容 |
|---|---|
| Correctness | 不変条件・境界値・状態遷移・API互換性・認可 |
| Maintainability | 命名・lint抑制・アンチパターン・複雑性・責務分離 |
| Resilience & Security | 異常系・非同期・セキュリティ脆弱性・外部障害耐性 |

エンジンは `deepseek-v4-flash`（DeepSeek Anthropic互換API）。`DEEPSEEK_API_KEY` シークレットのみ必要。詳細仕様は `workflows/SPEC.md`。

### ターゲットリポジトリへの導入

対象プロジェクトで `/gh-maestro` を初回起動すると自動的に実行される。

以下を自動で実行する：

1. `reviewer.lock.yml`・`reviewer.md`・`shared/` を `main` / `dev` ブランチの `.github/workflows/` に配置
2. `DEEPSEEK_API_KEY` が未設定の場合は設定コマンドを案内する

## スキルの構造

スキルは `skills/` 配下に1ディレクトリ1スキルで管理する。

```
skills/
  agents.yaml                    # エージェント定義（インストール先・プレースホルダー値）
  gh-maestro-orchestrator/
    SKILL.md                     # テンプレート（{{SCRIPTS_PATH}} を使用）
  gh-maestro-coder/
    SKILL.md
  ...
scripts/                         # 全スクリプト（CLI・モジュール）のソース。install.js もここ
```

**スクリプトの配置（重要）**: スクリプトはすべて `scripts/` に置く（CLI スクリプトも
`link-node-modules` のようなモジュールも区別なく同居）。インストール時、`scripts/` は
**そのまま `~/.gh-maestro/scripts/` にミラー**される（リポジトリの `scripts/` と1:1対応）。
スキルのインストール先（`~/.claude/skills/<skill>/` 等）には `SKILL.md` のみが置かれ、
`scripts/` サブディレクトリは作られない。

`SKILL.md` 内の `{{SCRIPTS_PATH}}` は、インストール時にこの集約先 `~/.gh-maestro/scripts` の
**絶対パス**に置換される（全エージェント・全スキルで同一）。これにより参照は1規約・配置は1か所に統一される。
スクリプト同士は同居しているので `require('./xxx')` で相互参照でき、リポジトリ実行・
インストール先実行のどちらでも解決する。

**新スキルの追加**: `skills/` 配下にディレクトリを作成して `SKILL.md` を置く。スクリプトが要るなら `scripts/` に追加する。

**新エージェントの追加**: `agents.yaml` にエントリを追加してインストールスクリプトを再実行する。

## レビューポリシー

インストール時に Google Engineering Practices をベースにしたデフォルトのレビューポリシーが `~/.gh-maestro/review-policy.md` に配置される。レビュワーはこれを自動的に参照してPRを評価する。

プロジェクト固有の基準を追加したい場合は、対象プロジェクトのルートに `.gh-maestro/review-policy.md` を作成する。レビュワーはグローバルポリシーに加えてプロジェクトポリシーも参照する。

```
~/.gh-maestro/review-policy.md       # デフォルト（gh-maestroが提供・更新時に上書き）
<project>/.gh-maestro/review-policy.md  # プロジェクト固有（任意・リポジトリで共有可）
```

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

## アーキテクチャ

gh-maestro は **GitHub Issue のコメント** をメッセージバスとして、 orchestrator と worker エージェント間で通信する。

- 各 worker は固有の **アンカー Issue** を持ち、全てのメッセージはその Issue へのコメントとして送受信される
- 起動時の指示は Issue 本文を worker が直接参照し、以降のやり取りを Issue コメント経由で行う

詳細な仕様は `docs/github-comm-plan.md` を参照。

> **注意**: Issue コメントの可視性はリポジトリの可視性に従う。トークン・認証情報・個人情報をメッセージ本文に含めてはならない。

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

あとは orchestrator の指示に従って開発を進める。 orchestrator と worker 間の通信はすべて GitHub Issue コメントを介して行われ、指示・報告が永続化される。

```
# 機能追加の場合
あなた: 「ログイン機能を追加したい」
orchestrator: Issue を起草・作成
orchestrator: coder をアンカー Issue と共に起動（coder は Issue 本文を読んで着手）
coder: 実装・PR 作成（進捗・結果を Issue コメントで報告）
CI: AI Code Review が自動実行（正確性・保守性・堅牢性）
orchestrator: レビュー結果をトリアージ → あなたにマージを依頼

# バグ調査の場合
あなた: 「Issue #12 のバグを調査してほしい」
orchestrator: investigator をアンカー Issue と共に起動（investigator は Issue 本文を読んで着手）
investigator: 根本原因/影響範囲/修正方針を Issue コメントで報告
orchestrator: 調査結果をあなたに提示 → 対応方針を判断
```

## AI Code Review

PR作成時またはコミットのpush時、ローカルでAIレビュワー `reviewer`（Review Manager）が自動的に実行され、3観点を独立してレビューし、観点ごとに別々のレビューをGitHub PRに投稿する。

| 観点 | 内容 |
|---|---|
| Correctness | 不変条件・境界値・状態遷移・API互換性・認可 |
| Maintainability | 命名・lint抑制・アンチパターン・複雑性・責務分離 |
| Resilience & Security | 異常系・非同期・セキュリティ脆弱性・外部障害耐性 |

エンジンには `gh-maestro-reviewer` スキルを使用する。

### 動作の仕組み

PR作成などを契機に、バックグラウンドプロセスとして `start-review-manager.js` が起動し、以下の処理を実行する。

1. `run-review-manager.js` が各観点のサブエージェント（Reviewer）を並列で実行
2. 各Reviewerが `reviewer-*.md` の基準に沿ってレビューを実行
3. レビュー結果が統合され、`review-publisher.js` を介して GitHub PR にコメントとして投稿される

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

## レビュー

Review Manager（`run-review-manager.js`）は `gh-maestro-reviewer` スキルを使い、
Correctness / Maintainability / Resilience & Security の3観点を独立Reviewerに分けてPRを評価する。
観点別基準は `skills/gh-maestro-reviewer/reviewer-*.md` を編集する。

# gh-maestro

GitHubを永続ストアとして、複数のAIエージェントを協調動作させるオーケストレーションシステム。Issue起票からPRマージまでの開発サイクルを自動化する。

## 前提条件

| 項目 | 要件 |
|---|---|
| OS | Windows / Linux / macOS |
| ターミナル | [WezTerm](https://wezfurlong.org/wezterm/)（Issueごとに自動起動する対話型ワーカー assistant のウィンドウに使用。ワーカー本体はターミナルを使わない） |
| ランタイム | Node.js 18以上 |
| orchestrator | **`claude`（Claude Code）のみ。** 他のエージェントでは動作しない（後述） |
| worker（任意） | `claude` / `agy`（Antigravity）/ `codex`（Codex）/ `reasonix` から選択 |
| GitHub CLI | `gh`（`gh auth login` 済み） |
| リポジトリ | `origin` リモートが GitHub を向いていること |

## アーキテクチャ

gh-maestro は **GitHub Issue のコメント** をメッセージバスとして、 orchestrator と worker エージェント間で通信する。

- 各 worker は固有の **アンカー Issue** を持ち、全てのメッセージはその Issue へのコメントとして送受信される
- 起動時の指示は Issue 本文を worker が直接参照し、以降のやり取りを Issue コメント経由で行う

詳細な仕様は `docs/github-comm-plan.md` を参照。

> **注意**: Issue コメントの可視性はリポジトリの可視性に従う。トークン・認証情報・個人情報をメッセージ本文に含めてはならない。

### orchestrator は Claude Code 専用

orchestrator の手順は Claude Code の **Monitor ツール**（バックグラウンドスクリプトの出力を通知として受け取る）と `TaskStop` を前提に組み立てられている。inbox 監視（`msg-poll.js`）・PR 監視（`poll-pr.js`）・ワーカーログの追尾がいずれもこれに依存するため、Monitor を持たないエージェントでは orchestrator を務められない。

worker は Monitor を必要としない。orchestrator からの追加指示は `inbox-supervisor.js` がプロセスの再開（resume）として配送するため、worker 側はポーリングを一切行わない。したがって worker には agy / codex / reasonix を自由に割り当てられる（`skillAgentMap` 参照）。

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
2. `claude`（Claude Code）を起動する
3. `/gh-maestro` を入力する

あとは orchestrator の指示に従って開発を進める。 orchestrator と worker 間の通信はすべて GitHub Issue コメントを介して行われ、指示・報告が永続化される。

```
# 機能追加の場合
あなた: 「ログイン機能を追加したい」
orchestrator: Issue を起草・作成
orchestrator: coder をアンカー Issue と共に起動（coder は Issue 本文を読んで着手）
coder: 実装・PR 作成（進捗・結果を Issue コメントで報告）
orchestrator: PR を検出して Review Manager をローカル起動（正確性・保守性・堅牢性）
orchestrator: レビュー結果をトリアージ → あなたにマージを依頼

# バグ調査の場合
あなた: 「Issue #12 のバグを調査してほしい」
orchestrator: investigator をアンカー Issue と共に起動（investigator は Issue 本文を読んで着手）
investigator: 根本原因/影響範囲/修正方針を Issue コメントで報告
orchestrator: 調査結果をあなたに提示 → 対応方針を判断
```

## AI Code Review

PRが作成されると、ローカルでAIレビュワー `reviewer`（Review Manager）が自動的に実行され、3観点を独立してレビューし、観点ごとに別々のレビューをGitHub PRに投稿する。

**レビューが走るのは初回のPR作成時だけである。** その後コーダーが修正をpushしても再レビューは実行されない（`PR_PUSH` は通知されるが、レビューは再実行されない）。再レビューが必要なときは `start-review-manager.js` を手動で起動する。

| 観点 | 内容 |
|---|---|
| Correctness | 不変条件・境界値・状態遷移・API互換性・認可 |
| Maintainability | 命名・lint抑制・アンチパターン・複雑性・責務分離 |
| Resilience & Security | 異常系・非同期・セキュリティ脆弱性・外部障害耐性 |

エンジンには `gh-maestro-reviewer` スキルを使用する。

### 動作の仕組み

orchestrator が起動した `poll-pr.js` がPRを検出すると、`start-review-manager.js` がバックグラウンドで起動し、以下の処理を実行する。

1. `run-review-manager.js` が各観点のサブエージェント（Reviewer）を並列で実行
2. 各Reviewerが観点別ディレクトリ（`correctness/`・`maintainability/`・`resilience-security/`）の基準ファイルに沿ってレビューを実行
3. レビュー結果が統合され、`review-publisher.js` を介して GitHub PR にコメントとして投稿される

### ポーリングプロセスの自律終了

PR・レビューの監視プロセスは、放置しても溜まらないよう自分で終わる。手動で止める必要はない。

| プロセス | 役割 | 終了条件 |
|---|---|---|
| `poll-pr.js` | Issue に対する PR の出現を待つ。検出したら Review Manager を起動し、`poll-reviews.js` を子プロセスとして起動して出力を中継する | 子の `poll-reviews.js` が終了したとき |
| `poll-reviews.js` | PR のコメント・レビュー・push・マージを監視して出力する | `PR_MERGED` を検出したとき（`cleanup()` 後に exit 0） |

加えて両者とも **dead-man's switch** を持つ。ポーリングの毎周回で親セッション（オーケストレーター）の生存を確認し、消えていれば PID レジストリを解除して自動終了する。セッションを閉じても孤児プロセスが残らない。

稼働中のプロセスは `.gh-maestro/pids/` に登録され、`reset-session.js` がまとめて掃除できる。

## スキルの構造

スキルは `skills/` 配下に1ディレクトリ1スキルで管理する。

```
skills/
  agents.yaml                    # エージェント定義（インストール先・プレースホルダー値）
  _partials/                     # 複数SKILL.mdで共有する部分テンプレート（先頭 _ は配布対象外）
  gh-maestro/                    # /gh-maestro 起動スキル
  gh-maestro-orchestrator/
    SKILL.md                     # テンプレート（{{SCRIPTS_PATH}} を使用）
  gh-maestro-coder/              # 以下ワーカー系
  gh-maestro-senior-coder/
  gh-maestro-investigator/
  gh-maestro-explorer/
  gh-maestro-architect/
  gh-maestro-base/               # 動的ワーカー生成の骨格
  gh-maestro-reviewer/           # Review Manager（観点別基準ファイルを同梱）
  gh-maestro-assistant/          # Issueごとに自動起動する対話型ワーカー
  gh-maestro-pending-triage/     # 保留Issueのトリアージ
  gh-maestro-init/               # 対象プロジェクトのlint/test設定を整備
  gh-maestro-install/            # インストール/更新
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

## worker の実行ログ

worker は画面を持たないバックグラウンドプロセスとして動く。標準出力/標準エラーは実行中から逐次
`<workspace>/.gh-maestro/worker-logs/<workerName>.log` へ書き込まれる（1ワーカー1ファイル、初回起動もresumeも同じファイルに追記）。

worker の報告は Issue コメントとして届くため、通常このログを読む必要はない。異常終了の切り分けや、
実行中の経過を追いたいときに参照する。

Review Manager のログも同じ `<workspace>/.gh-maestro/worker-logs/review-manager-<PR>.log` にある。

## レビュー

Review Manager（`run-review-manager.js`）は `gh-maestro-reviewer` スキルを使い、
Correctness / Maintainability / Resilience & Security の3観点を独立Reviewerに分けてPRを評価する。

観点別基準は `skills/gh-maestro-reviewer/` 配下の各観点ディレクトリにある基準ファイルを編集する。

```
skills/gh-maestro-reviewer/
  correctness/              # Correctness観点
    api-contract.md           API互換性・契約
    concurrency.md            並行処理・競合
    logic-invariants.md       不変条件・境界値
  maintainability/          # Maintainability観点
    structure-naming.md       命名・構造・アンチパターン
    test-quality.md           テスト品質
  resilience-security/      # Resilience & Security観点
    failure-recovery.md       異常系・障害耐性
    hostile-input.md          セキュリティ脆弱性・不正入力
```

## 設定（config.json）

`~/.gh-maestro/config.json`（グローバル）と `<workspace>/.gh-maestro/config.json`（ワークスペースローカル）で動作設定を上書きできる。解決順序は以下のとおり（後勝ち）。

1. `scripts/agent-defaults.json`（デフォルト、リポジトリ由来）
2. `~/.gh-maestro/config.json`（グローバル）
3. `<workspace>/.gh-maestro/config.json`（ワークスペースローカル）

### agents

エージェント単位の設定を上書きする。キーにエージェントID、値に上書きしたいフィールドを指定する。

```json
{
  "agents": {
    "claude-ds": {
      "command": "pwsh",
      "extraArgs": ["-Command", "claude-ds --dangerously-skip-permissions"],
      "promptFlag": null
    }
  }
}
```

各エージェントのデフォルト値は `scripts/agent-defaults.json` を参照。

**セキュリティ**: ワークスペースローカルの `config.json` からは `command`・`extraArgs`・`execArgs`・`extends`（後述）の上書きはできない（悪意あるリポジトリによる任意コマンド実行の防止）。グローバルの `~/.gh-maestro/config.json` では全フィールドの上書きが可能。

#### extends — 既存エージェントを土台にしたカスタムエージェント

gh-maestroが実際に細かい起動設定を必要とするのは claude / codex / agy / reasonix の4種のCLIランタイムだけで、他はモデル選択等を内部で行うラッパー（PowerShell関数等）に過ぎないことが多い。`extends` に既存のエージェントIDを指定すると、そのエージェントの設定を丸ごと土台にでき、`agent-defaults.json` を編集せずに `~/.gh-maestro/config.json` だけで新しいエージェントを登録できる。

```json
{
  "agents": {
    "codex-terra": { "extends": "codex", "command": "codex-terra" }
  }
}
```

**注意（マージ挙動の非対称性）**: `extends` を指定したオーバーライドは、通常のフィールド単位マージ（前述の例のように一部フィールドだけ差し替える）とは異なり、`extends` 先の設定を丸ごと土台にした**総入れ替え**になる。そのエージェントIDが既に `agent-defaults.json` に存在していても、そのデフォルト値は使われず、`extends` 先の設定に置き換わる。

配列フィールド（`extraArgs`・`execArgs`・`resumeCommand`・`nonInteractiveTokens` 等）は、継承元の配列内容に自分の内容を**末尾追記（マージ）**する。順序は「継承元の配列 → 自分の配列」の連結で、継承元で指定していた非対話トークン（`--print` 等）は失われない。`extends` を使わない通常のオーバーライド（前述の `agents` の例）では従来どおり配列は完全置換される。**完全置換**（継承元の配列を捨てて自分の配列だけにする）したい場合は `extends` を使わずに定義する。`extends` は `agent-defaults.json` 内のエージェントのみを対象にでき、`config.json` だけで定義した別のカスタムエージェントを連鎖して継承することはできない。

### skillAgentMap

スキル名→エージェントIDのマッピングを定義する。`gh-maestro-orchestrator` がワーカー起動時に使用する。確認・変更は `scripts/config.js` を使用する。

```json
{
  "skillAgentMap": {
    "gh-maestro-coder": "claude-ds",
    "gh-maestro-base": "agy",
    "gh-maestro-reviewer": "codex"
  }
}
```

### profiles

`skillAgentMap` の名前付きプリセット。`scripts/config.js use` で切り替える。各プロファイルは `skillAgentMap` を持ち、アクティブなプロファイルのマッピングがトップレベルの `skillAgentMap` より優先される。

```json
{
  "profiles": {
    "default": {
      "skillAgentMap": {
        "gh-maestro-coder": "claude-ds",
        "gh-maestro-reviewer": "codex"
      }
    },
    "peak": {
      "skillAgentMap": {
        "gh-maestro-coder": "agy",
        "gh-maestro-base": "agy"
      }
    }
  }
}
```


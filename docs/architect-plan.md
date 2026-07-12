# gh-maestro Architect 導入計画書

## 1. 目的と責務
要求仕様のブラッシュアップ、アーキテクチャ設計、設計変更に伴う **「計画書（Markdownファイル）」の作成**、および **「相談役（オーケストレーターからの設計判断相談へのアドバイス）」** を担うワーカーとして `gh-maestro-architect` を導入する。

* **受動的な動作**: 自発的に行動することは一切なく、常にオーケストレーターから明確に依頼された内容（相談や計画書作成タスク）のみをオンデマンドで処理する。
* **出力・動作制限**: コードの変更、テストの実装、IssueやPR作成、事実調査などの余計な開発実務は一切行わず、成果物は計画書の出力または相談への回答に限定する。
* **モデル選定はこの計画の対象外**: `gh-maestro-architect` が使うエージェントは、既存の `agent-defaults.json` 定義済みエージェント（`claude` / `claude-ds` / `claude-ds-pro` / `agy` / `reasonix` / `codex`）から `skillAgentMap` でユーザーが選択する。新しいエージェントID（`claude-fable` 等、将来PowerShell関数として個別定義予定のもの）をこの計画で追加することはしない。

## 2. 変更・追加対象ファイル

### ① `skills/gh-maestro-architect/SKILL.md` (新規)
上記目的・責務を指示するスキル定義。成果物の提出や相談への回答は、既存の msg-bus 経由（`scripts/msg-send.js`）で orchestrator へ送るルールを定義する。計画書本体はワークスペース内のMarkdownファイルとして出力し、msg-send で送るのはそのファイルパスの通知のみとする（本文をメッセージに直接載せない）。

### ② `scripts/agent-defaults.json` の更新
`skillAgentMap` に `gh-maestro-architect` のデフォルトエントリを追加する。デフォルト値は既存エージェントの中から選ぶ（例: `claude`）。新規エージェント定義の追加は不要。

```json
{
  "skillAgentMap": {
    "gh-maestro-architect": "claude"
  }
}
```

### ③ 解決ロジックの追加実装は不要
`skillAgentMap` / エージェント設定の解決優先度（`workspace/.gh-maestro/config.json` > `~/.gh-maestro/config.json` > `agent-defaults.json`）は `scripts/shared/resolve-config.js`（`resolveSkillAgentMap` / `resolveAgentConfig`）としてすでに実装済みであり、`spawn-worker.js` も既にこれを利用している。ユーザーは以下のように `~/.gh-maestro/config.json` または `workspace/.gh-maestro/config.json` に `skillAgentMap` を書くだけで、`gh-maestro-architect` に割り当てるエージェントを既存の6種から選び直せる。

```json
{
  "skillAgentMap": {
    "gh-maestro-architect": "codex"
  }
}
```

### ④ `skills/gh-maestro-orchestrator/SKILL.md` の更新
* 「ワーカーの使い分け」表に `gh-maestro-architect` を追加する。
* 人間から「アーキテクトに相談しろ」「計画書を作らせろ」と指示された際、あるいはオーケストレーター自身が実装判断や設計面で迷った際に、`spawn-worker.js` を実行して `gh-maestro-architect` を起動するルールを追加する。

## 3. 手順
1. `scripts/agent-defaults.json` の `skillAgentMap` に `gh-maestro-architect` のデフォルトエントリを追記。
2. `skills/gh-maestro-architect/SKILL.md` を新規作成。
3. `skills/gh-maestro-orchestrator/SKILL.md` に連携ルールを追記。
4. **`dev` ブランチにマージ後**、インストールスクリプトを実行し、配布物を更新する（WIPブランチから実行しない）。
   ```sh
   node scripts/install.js
   ```
5. `npm test` を実行してテストが正常に通ることを確認する。

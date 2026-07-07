# gh-maestro Architect 導入計画書

## 1. 目的と責務
要求仕様のブラッシュアップ、アーキテクチャ設計、設計変更に伴う **「計画書（Markdownファイル）」の作成**、および **「相談役（オーケストレーターからの設計判断相談へのアドバイス）」** を担うワーカーとして `gh-maestro-architect` を導入する。

* **受動的な動作**: 自発的に行動することは一切なく、常にオーケストレーターから明確に依頼された内容（相談や計画書作成タスク）のみをオンデマンドで処理する。
* **出力・動作制限**: コードの変更、テストの実装、IssueやPR의作成、事実調査などの余計な開発実務は一切行わず、成果物は計画書の出力または相談への回答に限定する。

## 2. 変更・追加対象ファイル

### ① `skills/gh-maestro-architect/SKILL.md` (新規)
上記目的・責務を指示するスキル定義。成果物の提出や相談の回答は `send-pane.js` または `queue-send.js` で orchestrator へ送るルールを定義する。

### ② `scripts/install.js` の更新
`defaults` 配列に、最新の高性能モデルを個別に指定した以下のエージェントID定義を追加する。
* **`claude-fable`**: `command: 'claude'`, `extraArgs: ['--dangerously-skip-permissions', '--model', 'fable']`
* **`codex-gpt`**: `command: 'codex'`, `extraArgs: ['--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen', '--model', 'gpt-5.6']`

### ③ `scripts/spawn-worker.js` の更新
* `skillAgentMap` に `gh-maestro-architect` を追加し、標準のデフォルトを `claude-fable` とする。
* **設定ファイルによる解決優先度 (ベストプラクティス)**:
  ワークスペース配下の `.gh-maestro/config.json`（存在しない場合はグローバルの `~/.gh-maestro/config.json`）をロードし、マッピング設定（`skillAgentMap` オブジェクト）が存在すれば、スクリプトのデフォルト値よりも優先して使用する。
  ```json
  {
    "skillAgentMap": {
      "gh-maestro-architect": "codex-gpt"
    }
  }
  ```

### ④ `skills/gh-maestro-orchestrator/SKILL.md` の更新
* 「ワーカーの使い分け」表に `gh-maestro-architect` を追加する。
* 人間から「アーキテクトに相談しろ」「計画書を作らせろ」と指示された際、あるいはオーケストレーター自身が実装判断や設計面で迷った際に、`spawn-worker.js` を実行して `gh-maestro-architect` を起動するルールを追加する。

## 3. 手順
1. `scripts/install.js` に `claude-fable` と `codex-gpt` の定義を追記。
2. `scripts/spawn-worker.js` の解決処理に `config.json` 読み込みロジックを実装。
3. `skills/gh-maestro-architect/SKILL.md` を新規作成。
4. `skills/gh-maestro-orchestrator/SKILL.md` に連携ルールを追記。
5. インストールスクリプトを実行し、配布物を更新する。
   ```sh
   node scripts/install.js
   ```
6. `npm test` を実行してテストが正常に通ることを確認する。

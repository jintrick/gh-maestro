# gh-maestro-senior-coder 実装計画書

## 【具体的パート (Implementation Details)】
実装上の具体的な変更手順と対象ファイル。

### 1. `scripts/install.js` の更新
`defaults` 配列に `claude-ds-pro` エントリを追加する。
* ※ `skills/agents.yaml` は修正しない（既存の `claude` CLI 設定をそのまま流用し、`~/.claude/skills` にデプロイされるため）。

### 2. `skills/gh-maestro-senior-coder/SKILL.md` の新規作成
[gh-maestro-coder/SKILL.md](file:///C:/Users/Jintrick/work/gh-maestro/skills/gh-maestro-coder/SKILL.md) をコピーし、シニアワーカー用の高度な設計判断やコード品質検証ルールを含むスキル定義を作成する。

### 3. `scripts/spawn-worker.js` の更新
オーケストレーターが具体的なエージェントIDを意識しなくて済むよう、`--agent` が指定されなかった場合のフォールバックロジックを「スキル単位のマッピング」に改める。
* `gh-maestro-coder` / `gh-maestro-base` → `claude-ds` をデフォルトに
* `gh-maestro-senior-coder` → `claude-ds-pro` をデフォルトに
* `gh-maestro-investigator` → `reasonix` をデフォルトに
* `gh-maestro-explorer` → `agy` をデフォルトに

---

## 【抽象的パート (Policy & Design Rules)】
オーケストレーターの挙動およびエージェントの使い分けに関する設計思想。

### 1. スキルベースでの自律的な使い分け
[skills/gh-maestro-orchestrator/SKILL.md](file:///C:/Users/Jintrick/work/gh-maestro/skills/gh-maestro-orchestrator/SKILL.md) からは、**具体的なエージェント名やエージェントマッピングに関する記述を完全に削除する**。
代わりに、各スキルの「能力的な特長」のみを記述し、実際の選択はオーケストレーターの自律的な判断に委ねる。

* **`gh-maestro-coder` スキルの特長**:
  * コスト効率に優れ、指定されたスコープに閉じた局所的な変更や、明確に定義された仕様の実装・修正に適している。
* **`gh-maestro-senior-coder` スキルの特長**:
  * 高度な自己検証能力とアーキテクチャの整合性判断能力を持ち、広範な影響分析、複雑なロジック調整、設計判断を伴うタスクの解決に適している。

オーケストレーターはこれらの特長を理解した上で、最初の起動時にどちらをアサインすべきかを課題ごとに判断する。

### 2. 人間承認型エスカレーションフロー
通常コーダーで実行して失敗しエスカレーション（`human-escalation`）された場合において、人間が承認した際に `gh-maestro-senior-coder` スキルを適用して再起動するフローを並行して定義する。

---

## 【手順】
1. `scripts/install.js` の `defaults` に `claude-ds-pro` を追加する。
2. `scripts/spawn-worker.js` の `--agent` 自動決定ロジックを実装する。
3. `skills/gh-maestro-senior-coder/SKILL.md` を新規作成する。
4. `skills/gh-maestro-orchestrator/SKILL.md` を更新し、**既存のエージェントに関する記述（「ワーカー別エージェント」表など）を完全に削除**し、各スキルの特長ベースの使い分けルールに書き換える。
5. `node scripts/install.js` と `npm test` を実行する。

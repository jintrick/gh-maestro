---
paths:
  - "scripts/agent-defaults.json"
  - "scripts/install.js"
  - "scripts/shared/resolve-config.js"
---

# agent-defaults.json の読み込みは構造検証してから使う

`scripts/agent-defaults.json` はJSONファイルであり、手編集・マージmiss等で `agents` が配列でなくなる、フィールドが欠落する等の壊れ方をしうる。これを読み込む側が構造を信頼して直接 `.map()`/`.find()`/spread等を行うと、TypeErrorでクラッシュする（インストーラーの場合）か、実行時例外でエージェント解決自体が失敗する（`resolve-config.js`の場合）。

- 実障害: `scripts/install.js` の一部読み込み箇所は `Array.isArray(parsed.agents)` で検証していたが、別の読み込み箇所（マイグレーション処理）と `scripts/shared/resolve-config.js`（`loadDefaults`・`resolveAgentConfig`・`resolveSkillAgentMap`）は無検証のまま `agents`/`skillAgentMap` を直接使っており、同一ファイル内・別ファイル間で防御が不揃いだった（PR #131 Review Manager指摘、Issue #130）。
- 対策: `agent-defaults.json` を新しく読み込む・読み込み箇所を追加する際は、`scripts/shared/validate-agent-defaults.js` の `validateAgentDefaults` で構造を検証してから使う。検証を経ずに `agents`/`skillAgentMap` の中身を直接操作しない。検証失敗時は `.claude/rules/fail-closed-safety-guards.md` の方針に従い、警告に留めず中断する。

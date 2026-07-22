---
paths:
  - "scripts/run-review-manager.js"
  - "scripts/start-review-manager.js"
  - "scripts/shared/review-manager-paths.js"
  - "scripts/review-findings-schema.json"
---

# review-manager launcher群の成果物・パス・ログに関する規約

- findings JSON（`review-manager-<PR>.json`）はスキーマ（`review-findings-schema.json`、`additionalProperties: false`）と `skills/gh-maestro-reviewer/SKILL.md` のOUTPUT定義で契約が固定されている。launcher側のメタデータをトップレベルに追記しない。別ファイルに分離するか、スキーマ・SKILL.md・全consumerを同時に更新すること（PR #84 Review Manager指摘）。現状launcherはfindings JSON以外の成果物を作らない（`review-manager-<PR>.meta.json`は観点モード廃止に伴い削除済み）。将来launcher側の観測用メタデータを追加する場合のみ、この分離ルールに従う。
- 呼び出し元が渡す自由入力テキストを将来ログや成果物JSONに書き込む場合、秘匿情報を含み得るため本文を無加工で書き込まない。トレーサビリティが必要ならハッシュ値・バイト長等の非機微なメタデータのみ記録する（PR #84 Review Manager指摘）。
- `pr`等の外部由来識別子をファイルパス構築に使う場合は、`scripts/shared/review-manager-paths.js` のパターン（識別子の形式検証 + 解決後パスが対象ディレクトリ配下に収まることの確認）を使う。生の `path.join` やテンプレートリテラルで直接組み立てない（path traversal対策、PR #84 Review Manager指摘）。
- config駆動の起動引数に埋め込まれる `{workspace}` 等のプレースホルダーは、`"--workspace={workspace}"` のような複合文字列内に現れうる。`a === '{placeholder}'` の完全一致判定ではなく `a.replace(/{placeholder}/g, value)` で置換すること（PR #95 Review Manager指摘）。

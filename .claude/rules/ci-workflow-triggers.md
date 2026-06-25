---
paths:
  - "workflows/**/*.yml"
  - "workflows/**/*.yaml"
  - "workflows/**/*.md"
  - ".github/workflows/**/*.yml"
  - ".github/workflows/**/*.yaml"
---

# CI ワークフロールール

レビューCIは **単一ワークフロー `reviewer.md`**（correctness/maintainability/resilience を1本に統合）。仕様は `workflows/SPEC.md`。

- `pull_request.types` に `synchronize` を含めてはならない（再実行は close→reopen）
- 既存ワークフローを書き直す際は必ず Read して現状を確認すること
- PR番号は `${{ github.event.pull_request.number }}`。`inputs.pr_number` は workflow_call の名残なので使わない
- `{{#runtime-import}}` のパスは `.github/workflows/` 基準（`shared/...` であって `workflows/shared/...` ではない）
- frontmatter（トリガー・engine・max-turns 等）変更後は **ユーザーに依頼**：`gh aw compile -d workflows` → `node scripts/setup-ai-review.js <owner/repo>`（Claude Code からの実行は必ず失敗する）

## submit-pull-request-review の罠

複数回呼んでも GitHub に残るのは1件（最後の body/event のみ採用）。`max` は 1 以外に意味がない。複数観点の区別はインラインコメントの body ラベルで表現し、submit は最後に1回だけ呼ぶこと。

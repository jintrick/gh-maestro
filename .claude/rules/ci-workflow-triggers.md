---
paths:
  - "workflows/**/*.yml"
  - "workflows/**/*.yaml"
  - ".github/workflows/**/*.yml"
  - ".github/workflows/**/*.yaml"
---

# CI ワークフロールール

- `pull_request.types` に `synchronize` を含めてはならない（再実行は close→reopen）
- 既存ワークフローを書き直す際は必ず Read して現状を確認すること
- `caller-template/ai-review.yml` の各 reviewer ジョブには reviewer 固有の `aw_context` が必須（artifact prefix衝突防止）
  - `review-correctness`: `aw_context: '{"reviewer":"correctness"}'`
  - `review-maintainability`: `aw_context: '{"reviewer":"maintainability"}'`
  - `review-resilience`: `aw_context: '{"reviewer":"resilience"}'`

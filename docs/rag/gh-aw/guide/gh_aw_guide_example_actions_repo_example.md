---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-actions-repo.md
original_title: test-actions-repo
fetched_at: 2026-06-14T00:40:10.018493+00:00
---

---
name: Test Actions Repo Override
on:
  workflow_dispatch:
permissions:
  contents: read
  issues: read
engine: copilot
safe-outputs:
  create-issue:
    max: 1
---

# Test Actions Repo Override

When instructed, create an issue summarizing the repository state.

---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-staged-add-comment.md
original_title: test-staged-add-comment
fetched_at: 2026-06-14T00:40:11.581927+00:00
---

---
on:
  workflow_dispatch:
permissions: read-all
engine: copilot
safe-outputs:
  staged: true
  add-comment:
    max: 1
---

# Test Staged Add Comment

Verify that `staged: true` works together with the `add-comment` handler.

Add a comment to issue #1 saying "Staged test comment."

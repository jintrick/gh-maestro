---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-staged-permissions-per-handler.md
original_title: test-staged-permissions-per-handler
fetched_at: 2026-06-14T00:40:11.621820+00:00
---

---
on:
  workflow_dispatch:
permissions:
  contents: read
engine: copilot
safe-outputs:
  create-issue:
    staged: true
    title-prefix: "[staged] "
    max: 1
  add-labels:
    max: 3
---

# Test Staged Permissions (Per-Handler)

Verify that when only specific handlers have `staged: true`, the compiled
safe_outputs job only includes permissions required by the non-staged handlers.

Here `create-issue` is staged (no write permissions for it), and `add-labels`
is not staged (needs `issues: write` and `pull-requests: write`).

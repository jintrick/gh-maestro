---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-staged-permissions-global.md
original_title: test-staged-permissions-global
fetched_at: 2026-06-14T00:40:11.614839+00:00
---

---
on:
  workflow_dispatch:
permissions:
  contents: read
engine: copilot
safe-outputs:
  staged: true
  create-issue:
    title-prefix: "[staged] "
    max: 1
  add-labels:
    max: 3
  create-discussion:
    max: 1
---

# Test Staged Permissions (Global)

Verify that when `staged: true` is set globally, the compiled safe_outputs job
has **no** job-level `permissions:` block (all handlers are staged, so no write
permissions are needed).

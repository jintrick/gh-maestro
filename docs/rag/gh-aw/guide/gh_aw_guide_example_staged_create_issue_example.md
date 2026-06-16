---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-staged-create-issue.md
original_title: test-staged-create-issue
fetched_at: 2026-06-14T00:40:11.597884+00:00
---

---
on:
  workflow_dispatch:
permissions: read-all
engine: copilot
safe-outputs:
  staged: true
  create-issue:
    title-prefix: "[staged] "
    max: 1
---

# Test Staged Create Issue

Verify that `staged: true` works together with the `create-issue` handler.

Create an issue titled "Staged test issue" with the body "This issue was created in staged mode."

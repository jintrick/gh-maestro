---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-staged-create-discussion.md
original_title: test-staged-create-discussion
fetched_at: 2026-06-14T00:40:11.588908+00:00
---

---
on:
  workflow_dispatch:
permissions:
  contents: read
engine: copilot
safe-outputs:
  staged: true
  create-discussion:
    max: 1
    category: general
---

# Test Staged Create Discussion

Verify that `staged: true` works together with the `create-discussion` handler.

Create a discussion titled "Staged test discussion" with the body "This discussion was created in staged mode."

---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-add-labels-target.md
original_title: test-add-labels-target
fetched_at: 2026-06-14T00:40:10.027471+00:00
---

---
on:
  workflow_dispatch:
permissions:
  contents: read
  actions: read
engine: claude
safe-outputs:
  add-labels:
    allowed: [bug, enhancement, documentation]
    target: "*"
---

# Test Add Labels with Target

This workflow demonstrates the `target` field for `add-labels`.

With `target: "*"`, the workflow can add labels to any issue by specifying
the `issue_number` in the output.

Please add the label "bug" to issue #1 and the label "documentation" to issue #2.

---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-copilot-remove-labels.md
original_title: test-copilot-remove-labels
fetched_at: 2026-06-14T00:40:10.997961+00:00
---

---
on:
  workflow_dispatch:
permissions:
  contents: read
  issues: read
engine: copilot
safe-outputs:
  remove-labels:
    max: 5
---

# Test Copilot Remove Labels

Test the `remove_labels` safe output type with the Copilot engine.

## Task

Remove the label "bug" from issue #1.

Output results in JSONL format using the `remove_labels` tool.

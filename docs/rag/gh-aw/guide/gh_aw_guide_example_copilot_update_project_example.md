---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-copilot-update-project.md
original_title: test-copilot-update-project
fetched_at: 2026-06-14T00:40:11.172495+00:00
---

---
on:
  workflow_dispatch:
permissions:
  contents: read
  issues: read
engine: copilot
safe-outputs:
  update-project:
    max: 5
---

# Test Copilot Update Project

Test the `update_project` safe output type with the Copilot engine.

## Task

Add issue #1 to a GitHub Project V2. Set the status field to "In Progress" for the added item.

Output results in JSONL format using the `update_project` tool.

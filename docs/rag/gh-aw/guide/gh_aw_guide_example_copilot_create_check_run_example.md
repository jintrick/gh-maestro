---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-copilot-create-check-run.md
original_title: test-copilot-create-check-run
fetched_at: 2026-06-14T00:40:10.729832+00:00
---

---
on:
  workflow_dispatch:
permissions:
  contents: read
  checks: write
engine: copilot
safe-outputs:
  create-check-run:
    max: 1
    name: "Copilot Analysis"
---

# Test Copilot Create Check Run

Test the `create_check_run` safe output type with the Copilot engine.

## Task

Create a GitHub Check Run with:
- **conclusion**: "success"
- **title**: "Copilot Analysis Complete"
- **summary**: "The automated analysis completed successfully. No issues were found."

Output results in JSONL format using the `create_check_run` tool.

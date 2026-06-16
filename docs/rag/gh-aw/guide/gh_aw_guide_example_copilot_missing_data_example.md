---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-copilot-missing-data.md
original_title: test-copilot-missing-data
fetched_at: 2026-06-14T00:40:10.934619+00:00
---

---
on:
  workflow_dispatch:
permissions:
  contents: read
  actions: read
  issues: read
  pull-requests: read
engine: copilot
safe-outputs:
  missing-data:
    max: 5
timeout-minutes: 5
---

# Test Copilot Missing Data

Test the `missing_data` safe output type with the Copilot engine.

## Task

Report missing data with transparency messages about the following:
- "Required issue number not found in the workflow trigger context"
- "Expected pull request branch name but no PR was associated with this run"
- "Configuration file 'config.json' not found in the repository root"

Output results in JSONL format using the `missing_data` tool.

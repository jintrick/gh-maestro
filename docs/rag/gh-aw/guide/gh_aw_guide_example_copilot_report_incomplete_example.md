---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-copilot-report-incomplete.md
original_title: test-copilot-report-incomplete
fetched_at: 2026-06-14T00:40:11.047828+00:00
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
  report-incomplete:
    max: 5
timeout-minutes: 5
---

# Test Copilot Report Incomplete

Test the `report_incomplete` safe output type with the Copilot engine.

## Task

Signal that the task could not be completed due to a simulated infrastructure failure. Report as incomplete with:
- **reason**: "Required MCP server was unavailable during workflow execution"
- **details**: "The workflow attempted to connect to the MCP server but received a connection refused error. This is a simulated failure for testing purposes."

Output results in JSONL format using the `report_incomplete` tool.

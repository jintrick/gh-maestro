---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-copilot-create-code-scanning-alerts.md
original_title: test-copilot-create-code-scanning-alerts
fetched_at: 2026-06-14T00:40:10.737647+00:00
---

---
on:
  workflow_dispatch:
permissions:
  contents: read
  security-events: read
engine: copilot
safe-outputs:
  create-code-scanning-alerts:
    driver: Test Scanner
    max: 3
timeout-minutes: 5
---

# Test Copilot Create Code Scanning Alerts

Test the `create_code_scanning_alert` safe output type with the Copilot engine.

## Task

Create a code scanning alert with the following details:
- **rule_id**: "TEST001"
- **rule_description**: "Test security rule for automated testing"
- **message**: "Found a potential test vulnerability"
- **path**: "src/test.js"
- **start_line**: 42
- **severity**: "warning"

Output results in JSONL format using the `create_code_scanning_alert` tool.

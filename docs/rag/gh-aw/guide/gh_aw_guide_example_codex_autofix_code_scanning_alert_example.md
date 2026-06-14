---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-codex-autofix-code-scanning-alert.md
original_title: test-codex-autofix-code-scanning-alert
fetched_at: 2026-06-14T00:40:10.496448+00:00
---

---
on: workflow_dispatch
permissions:
  contents: read
  actions: read
  security-events: read
engine: codex
safe-outputs:
  autofix-code-scanning-alert:
    max: 3
timeout-minutes: 5
---

# Test Autofix Code Scanning Alert (Codex)

Test the autofix_code_scanning_alert safe output type with the Codex engine.

## Task

You need to create an autofix for a code scanning alert. Use the `autofix_code_scanning_alert` tool to:

1. Create an autofix for alert number 1 with the following details:
   - **alert_number**: 1
   - **fix_description**: "Fix SQL injection vulnerability by using parameterized queries"
   - **fix_code**: `const query = db.prepare('SELECT * FROM users WHERE id = ?').bind(userId);`

2. Create an autofix for alert number 2:
   - **alert_number**: 2
   - **fix_description**: "Fix XSS vulnerability by escaping HTML entities"
   - **fix_code**: `const escaped = escapeHtml(userInput);`

Output the results in JSONL format using the autofix_code_scanning_alert tool.

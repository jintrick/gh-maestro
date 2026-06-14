---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-copilot-close-issue.md
original_title: test-copilot-close-issue
fetched_at: 2026-06-14T00:40:10.686938+00:00
---

---
on:
  workflow_dispatch:
permissions:
  contents: read
  issues: read
engine: copilot
safe-outputs:
  close-issue:
    max: 1
---

# Test Copilot Close Issue

Test the `close_issue` safe output type with the Copilot engine.

## Task

Close issue #1 with a reason of "completed" and a comment "Closing this issue as it has been resolved by the automated test workflow."

Output results in JSONL format using the `close_issue` tool.

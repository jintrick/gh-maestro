---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-copilot-link-sub-issue.md
original_title: test-copilot-link-sub-issue
fetched_at: 2026-06-14T00:40:10.878770+00:00
---

---
on:
  workflow_dispatch:
permissions:
  contents: read
  issues: read
engine: copilot
safe-outputs:
  link-sub-issue:
    max: 5
---

# Test Copilot Link Sub-Issue

Test the `link_sub_issue` safe output type with the Copilot engine.

## Task

Link issue #2 as a sub-issue of issue #1. This establishes a parent-child relationship between the two issues.

Output results in JSONL format using the `link_sub_issue` tool.

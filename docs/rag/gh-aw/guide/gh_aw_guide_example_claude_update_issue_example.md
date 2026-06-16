---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-claude-update-issue.md
original_title: test-claude-update-issue
fetched_at: 2026-06-14T00:40:10.434810+00:00
---

---
on:
  workflow_dispatch:
permissions:
  issues: read
engine: claude
---

# Test Claude Update Issue

This is a test workflow to verify that Claude can update existing GitHub issues.

Please update issue #1 by:
1. Changing the title to "Updated Test Issue"
2. Adding additional content to the body
3. Adding the label "updated" if it doesn't already exist
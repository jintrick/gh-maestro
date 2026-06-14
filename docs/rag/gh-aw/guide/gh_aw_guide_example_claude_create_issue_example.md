---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-claude-create-issue.md
original_title: test-claude-create-issue
fetched_at: 2026-06-14T00:40:10.210979+00:00
---

---
on:
  workflow_dispatch:
permissions:
  issues: read
engine: claude
---

# Test Claude Create Issue

This is a test workflow to verify that Claude can create new GitHub issues.

Please create a new issue with the title "Test Issue from Claude" and the body "This issue was created automatically by the Claude test workflow."
---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-copilot-create-issue.md
original_title: test-copilot-create-issue
fetched_at: 2026-06-14T00:40:10.756587+00:00
---

---
on:
  workflow_dispatch:
permissions:
  issues: read
engine: copilot
---

# Test Copilot Create Issue

This is a test workflow to verify that Copilot can create new GitHub issues.

Please create a new issue with the title "Test Issue from Copilot" and the body "This issue was created automatically by the Copilot test workflow."
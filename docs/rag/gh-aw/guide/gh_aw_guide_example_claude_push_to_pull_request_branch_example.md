---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-claude-push-to-pull-request-branch.md
original_title: test-claude-push-to-pull-request-branch
fetched_at: 2026-06-14T00:40:10.393949+00:00
---

---
on:
  workflow_dispatch:
permissions:
  contents: read
  pull-requests: read
engine: claude
---

# Test Claude Push to PR Branch

This is a test workflow to verify that Claude can push changes to an existing pull request branch.

Please:
1. Find the latest open pull request
2. Create a small change (like adding a comment to a file)
3. Push the change to the PR branch
4. Add a comment to the PR explaining what was changed
---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-claude-add-issue-comment.md
original_title: test-claude-add-issue-comment
fetched_at: 2026-06-14T00:40:10.139171+00:00
---

---
on:
  workflow_dispatch:
permissions:
  issues: read
engine: claude
---

# Test Claude Add Issue Comment

This is a test workflow to verify that Claude can add comments to GitHub issues.

Please add a comment to issue #1 saying "This is a test comment from the Claude workflow."
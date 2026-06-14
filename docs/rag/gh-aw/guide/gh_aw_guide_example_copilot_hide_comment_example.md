---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-copilot-hide-comment.md
original_title: test-copilot-hide-comment
fetched_at: 2026-06-14T00:40:10.854326+00:00
---

---
on:
  workflow_dispatch:
engine: copilot
safe-outputs:
  hide-comment:
    max: 3
timeout-minutes: 5
---

# Test Copilot Hide Comment

This is a test workflow to verify that Copilot can hide comments on GitHub issues.

Test the hide_comment safe output by hiding a comment with the following node ID:

- comment_id: "IC_kwDOABCD123456"

Output the hide-comment action as JSONL format using the hide_comment tool.

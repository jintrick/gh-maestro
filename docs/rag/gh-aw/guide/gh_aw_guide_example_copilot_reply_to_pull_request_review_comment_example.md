---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-copilot-reply-to-pull-request-review-comment.md
original_title: test-copilot-reply-to-pull-request-review-comment
fetched_at: 2026-06-14T00:40:11.006937+00:00
---

---
on:
  workflow_dispatch:
permissions:
  contents: read
  pull-requests: read
engine: copilot
safe-outputs:
  reply-to-pull-request-review-comment:
    max: 1
---

# Test Copilot Reply to Pull Request Review Comment

Test the `reply_to_pull_request_review_comment` safe output type with the Copilot engine.

## Task

Reply to pull request review comment #1 with the body "Thank you for the review comment. This is an automated test reply from the Copilot test workflow."

Output results in JSONL format using the `reply_to_pull_request_review_comment` tool.

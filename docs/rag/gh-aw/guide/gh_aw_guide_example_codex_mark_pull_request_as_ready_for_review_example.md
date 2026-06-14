---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-codex-mark-pull-request-as-ready-for-review.md
original_title: test-codex-mark-pull-request-as-ready-for-review
fetched_at: 2026-06-14T00:40:10.568255+00:00
---

---
on: workflow_dispatch
permissions:
  contents: read
engine: codex
safe-outputs:
  mark-pull-request-as-ready-for-review:
    max: 1
timeout-minutes: 5
strict: false
---

# Test Mark Pull Request as Ready for Review

You are testing the mark_pull_request_as_ready_for_review safe output type.

## Instructions

Your task is to mark a draft pull request as ready for review. Follow these steps:

1. Call the `mark_pull_request_as_ready_for_review` tool with:
   - `reason`: A clear explanation of why the PR is ready (e.g., "All tests passing, documentation updated, ready for team review")
   - `pull_request_number` (optional): If not provided, uses the triggering PR

2. The tool will:
   - Check if the PR is a draft
   - Set `draft: false` on the PR
   - Post a comment with your reason and workflow attribution

## Example

```
mark_pull_request_as_ready_for_review({
  reason: "Feature implementation complete. All unit tests passing and documentation has been updated. Ready for team review."
})
```

## Expected Behavior

- In **staged mode**: Shows a preview of what would be done (with 🎭 emoji)
- In **live mode**: Actually marks the PR as ready and posts the comment
- If PR is already not a draft, logs info message but doesn't fail
- Reason is sanitized to prevent XSS attacks
- Comment includes workflow attribution footer

Please test this functionality by calling the tool with an appropriate reason.

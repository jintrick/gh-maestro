---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-copilot-resolve-pull-request-review-thread.md
original_title: test-copilot-resolve-pull-request-review-thread
fetched_at: 2026-06-14T00:40:11.055807+00:00
---

---
on:
  workflow_dispatch:
permissions:
  contents: read
  pull-requests: read
engine: copilot
safe-outputs:
  resolve-pull-request-review-thread:
    max: 5
---

# Test Copilot Resolve Pull Request Review Thread

Test the `resolve_pull_request_review_thread` safe output type with the Copilot engine.

## Task

Resolve the pull request review thread with thread ID "PRRT_test123". This indicates the discussion in the thread has been addressed.

Output results in JSONL format using the `resolve_pull_request_review_thread` tool.

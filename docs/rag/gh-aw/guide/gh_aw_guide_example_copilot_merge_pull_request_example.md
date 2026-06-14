---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-copilot-merge-pull-request.md
original_title: test-copilot-merge-pull-request
fetched_at: 2026-06-14T00:40:10.926640+00:00
---

---
on:
  workflow_dispatch:
permissions:
  contents: read
  pull-requests: read
engine: copilot
safe-outputs:
  merge-pull-request:
    max: 1
    required-labels: ["automerge"]
    allowed-branches: ["feature/*", "fix/*"]
timeout-minutes: 5
---

# Test Copilot Merge Pull Request

Test the `merge_pull_request` safe output type with the Copilot engine.

## Task

Merge pull request #1 using the "squash" merge method with:
- commit_title: "Test: Squash merge via automated workflow"
- commit_message: "This pull request was merged automatically by the Copilot test workflow to verify the merge_pull_request safe output type."

Output results in JSONL format using the `merge_pull_request` tool.

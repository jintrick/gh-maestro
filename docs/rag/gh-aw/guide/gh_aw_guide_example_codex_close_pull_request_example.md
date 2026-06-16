---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-codex-close-pull-request.md
original_title: test-codex-close-pull-request
fetched_at: 2026-06-14T00:40:10.515396+00:00
---

---
on: workflow_dispatch
permissions:
  contents: read
  actions: read
engine: codex
safe-outputs:
  close-pull-request:
    max: 3
    required-labels: ["test", "automated"]
    required-title-prefix: "[bot]"
    target: "*"
timeout-minutes: 5
---

# Test Close Pull Request

Test the close-pull-request safe output functionality.

Close pull requests that match the following criteria:
- Have labels: test, automated
- Have title prefix: [bot]

Create close-pull-request entries with:
- body: "This pull request is being closed automatically as part of testing. The PR met the required criteria for automated closure."
- pull_request_number: 123 (example)

Output as JSONL format.

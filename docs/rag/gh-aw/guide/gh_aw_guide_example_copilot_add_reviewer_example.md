---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-copilot-add-reviewer.md
original_title: test-copilot-add-reviewer
fetched_at: 2026-06-14T00:40:10.613136+00:00
---

---
on:
  pull_request:
    types: [opened]
permissions:
  contents: read
  actions: read
engine: copilot
safe-outputs:
  add-reviewer:
    max: 3
timeout-minutes: 5
---

# Test Add Reviewer Safe Output

Test the add-reviewer safe output functionality.

Add reviewers to the pull request using the add_reviewer tool:
- Add "octocat" as a reviewer
- Add "github" as a reviewer

Output as JSONL format.

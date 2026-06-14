---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-copilot-create-discussion.md
original_title: test-copilot-create-discussion
fetched_at: 2026-06-14T00:40:10.748608+00:00
---

---
on:
  workflow_dispatch:
permissions:
  contents: read
engine: copilot
safe-outputs:
  create-discussion:
    max: 1
    category: general
---

# Test Copilot Create Discussion

Test the `create_discussion` safe output type with the Copilot engine.

## Task

Create a new GitHub discussion with the title "Test Discussion from Copilot" and the body "This discussion was created automatically by the Copilot test workflow to verify the create_discussion safe output type works correctly."

Output results in JSONL format using the `create_discussion` tool.

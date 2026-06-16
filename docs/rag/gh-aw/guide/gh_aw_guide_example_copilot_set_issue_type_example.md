---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-copilot-set-issue-type.md
original_title: test-copilot-set-issue-type
fetched_at: 2026-06-14T00:40:11.099689+00:00
---

---
on:
  workflow_dispatch:
permissions:
  contents: read
engine: copilot
safe-outputs:
  set-issue-type:
    allowed: ["Bug", "Feature", "Task"]
    max: 2
---

# Test Copilot Set Issue Type

This workflow tests the set-issue-type safe output type with Copilot engine.

Please set the type of issue #1 to "Bug".

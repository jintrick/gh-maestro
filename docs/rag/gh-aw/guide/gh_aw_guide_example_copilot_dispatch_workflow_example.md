---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-copilot-dispatch-workflow.md
original_title: test-copilot-dispatch-workflow
fetched_at: 2026-06-14T00:40:10.828396+00:00
---

---
on:
  workflow_dispatch:
permissions:
  contents: read
  actions: read
engine: copilot
safe-outputs:
  dispatch-workflow:
    max: 1
    workflows:
      - test-copilot-noop
---

# Test Copilot Dispatch Workflow

Test the `dispatch_workflow` safe output type with the Copilot engine.

## Task

Dispatch the workflow "test-copilot-noop" with no additional inputs.

Output results in JSONL format using the `dispatch_workflow` tool.

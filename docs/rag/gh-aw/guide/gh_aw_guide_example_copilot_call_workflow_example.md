---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-copilot-call-workflow.md
original_title: test-copilot-call-workflow
fetched_at: 2026-06-14T00:40:10.678959+00:00
---

---
on:
  workflow_dispatch:
permissions:
  contents: read
  actions: read
engine: copilot
safe-outputs:
  call-workflow:
    max: 1
    workflows:
      - test-copilot-noop
---

# Test Copilot Call Workflow

Test the `call_workflow` safe output type with the Copilot engine.

## Task

Call the reusable workflow "test-copilot-noop" as a fan-out job.

Output results in JSONL format using the `call_workflow` tool.

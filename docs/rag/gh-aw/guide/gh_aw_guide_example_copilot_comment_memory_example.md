---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-copilot-comment-memory.md
original_title: test-copilot-comment-memory
fetched_at: 2026-06-14T00:40:10.713866+00:00
---

---
on:
  workflow_dispatch:
permissions:
  contents: read
  issues: read
  pull-requests: read
engine: copilot
tools:
  comment-memory:
    max: 1
    memory-id: test-memory
timeout-minutes: 5
---

# Test Copilot Comment Memory

Test the `comment_memory` safe output type with the Copilot engine.

## Task

Update or create a memory comment on issue #1 with the body "Memory update: this is a test of the comment_memory safe output type. Timestamp: now."

Output results in JSONL format using the `comment_memory` tool.

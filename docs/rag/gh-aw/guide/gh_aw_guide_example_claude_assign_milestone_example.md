---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-claude-assign-milestone.md
original_title: test-claude-assign-milestone
fetched_at: 2026-06-14T00:40:10.155127+00:00
---

---
on:
  workflow_dispatch:
permissions:
  contents: read
  actions: read
engine: claude
safe-outputs:
  assign-milestone:
    max: 2
---

# Test Claude Assign Milestone

This workflow tests the assign-milestone safe output type with Claude engine.

Please assign issue #1 to milestone #5 and issue #2 to milestone #5.

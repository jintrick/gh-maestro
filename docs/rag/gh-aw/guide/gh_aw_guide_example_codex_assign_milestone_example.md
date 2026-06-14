---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-codex-assign-milestone.md
original_title: test-codex-assign-milestone
fetched_at: 2026-06-14T00:40:10.487471+00:00
---

---
on:
  workflow_dispatch:
permissions:
  contents: read
  actions: read
engine: codex
safe-outputs:
  assign-milestone:
    max: 2
---

# Test Codex Assign Milestone

This workflow tests the assign-milestone safe output type with Codex engine.

Please assign issue #1 to milestone #5 and issue #2 to milestone #5.

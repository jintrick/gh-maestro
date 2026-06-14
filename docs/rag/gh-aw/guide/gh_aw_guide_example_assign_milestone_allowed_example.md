---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-assign-milestone-allowed.md
original_title: test-assign-milestone-allowed
fetched_at: 2026-06-14T00:40:10.082322+00:00
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
    allowed: [v1.0, v2.0, Sprint 1]
    max: 3
---

# Test Assign Milestone with Allowed List

This workflow demonstrates the `allowed` field for `assign-milestone`.

With an allowed list of milestones, the workflow will only assign issues to
milestones that match the configured names.

Please assign:
- Issue #1 to milestone "v1.0"
- Issue #2 to milestone "v2.0"
- Issue #3 to milestone "Sprint 1"

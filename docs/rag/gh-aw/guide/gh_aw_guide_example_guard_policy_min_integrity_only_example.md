---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-guard-policy-min-integrity-only.md
original_title: test-guard-policy-min-integrity-only
fetched_at: 2026-06-14T00:40:11.330074+00:00
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
  github:
    min-integrity: none
---

# Test Guard Policy with min-integrity Only

This workflow verifies that specifying only `min-integrity` under `tools.github`
works correctly without requiring an explicit `repos` field.

When `repos` is omitted, it should default to `all`, allowing the workflow to compile
successfully.

Please list the first 3 open issues in this repository.

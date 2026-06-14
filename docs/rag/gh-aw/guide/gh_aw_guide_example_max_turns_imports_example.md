---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-max-turns-imports.md
original_title: test-max-turns-imports
fetched_at: 2026-06-14T00:40:11.379468+00:00
---

---
on:
  workflow_dispatch:
imports:
  - ./shared/max-turns-import.md
permissions:
  contents: read
  issues: read
  pull-requests: read
tools:
  github:
    allowed: [issue_read]
---

# Shared max-turns import fixture

Verifies that top-level `max-turns` from a shared workflow import is preserved through CLI compilation.

---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-safe-outputs-needs-imports.md
original_title: test-safe-outputs-needs-imports
fetched_at: 2026-06-14T00:40:11.505133+00:00
---

---
on:
  workflow_dispatch:
imports:
  - ./shared/safe-outputs-needs-import.md
safe-outputs:
  needs:
    - main_job
    - imported_job
jobs:
  main_job:
    runs-on: ubuntu-latest
    steps:
      - run: echo "main"
  imported_job:
    runs-on: ubuntu-latest
    steps:
      - run: echo "imported"
  shared_job:
    runs-on: ubuntu-latest
    steps:
      - run: echo "shared"
---

# Safe outputs needs imports fixture

Verify that safe-outputs.needs from imports is merged with top-level needs.

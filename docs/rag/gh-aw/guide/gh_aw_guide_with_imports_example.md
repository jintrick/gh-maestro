---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/workflow/testdata/wasm_golden/fixtures/with-imports.md
original_title: with-imports
fetched_at: 2026-06-14T00:40:12.435660+00:00
---

---
name: with-imports-test
description: Workflow with shared component imports
on:
  workflow_dispatch:
permissions:
  contents: read
engine: copilot
timeout-minutes: 10
imports:
  - shared/tools.md
---

# Mission

Use the imported tools to analyze the repository.

---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-top-level-github-app-otlp-import.md
original_title: test-top-level-github-app-otlp-import
fetched_at: 2026-06-14T00:40:11.702091+00:00
---

---
on:
  issues:
    types: [opened]
permissions:
  contents: read
  issues: read
  pull-requests: read
imports:
  - ./shared/otlp-github-app-import.md
tools:
  github:
    mode: remote
    toolsets: [default]
safe-outputs:
  create-issue:
    title-prefix: "[automated] "
engine: copilot
---

# OTLP GitHub App token minting from import

This workflow verifies `observability.otlp.github-app` is honored when configured in an imported workflow.

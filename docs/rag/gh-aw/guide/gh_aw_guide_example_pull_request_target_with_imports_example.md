---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-pull-request-target-with-imports.md
original_title: test-pull-request-target-with-imports
fetched_at: 2026-06-14T00:40:11.472220+00:00
---

---
on:
  pull_request_target:
    types: [opened, synchronize]
permissions:
  contents: read
  pull-requests: read
engine: copilot
imports:
  - ./shared/keep-it-short.md
tools:
  github:
    toolsets: [pull_requests]
---

# Test pull_request_target with checkout enabled and imports

Validate that pull_request_target without `checkout: false` emits a warning
even when shared workflow imports are present.

---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-pull-request-target-checkout-false.md
original_title: test-pull-request-target-checkout-false
fetched_at: 2026-06-14T00:40:11.464242+00:00
---

---
on:
  pull_request_target:
    types: [opened, synchronize]
permissions:
  contents: read
  pull-requests: read
engine: copilot
checkout: false
imports:
  - ./shared/keep-it-short.md
tools:
  github:
    toolsets: [pull_requests]
---

# Test pull_request_target with checkout disabled and imports

Validate that pull_request_target with `checkout: false` compiles successfully
even when shared workflow imports are present.

In strict mode this should emit a dangerous-trigger warning but succeed.

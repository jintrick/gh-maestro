---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-copilot-threat-detection-environment.md
original_title: test-copilot-threat-detection-environment
fetched_at: 2026-06-14T00:40:11.126617+00:00
---

---
description: Test workflow for top-level environment propagation to threat detection
on:
  workflow_dispatch:
    inputs:
      task:
        description: 'Task summary'
        required: true
        default: 'Check environment propagation'

environment: production
permissions: read-all

engine: copilot

safe-outputs:
  create-issue:
    title-prefix: "[bot] "
    labels: [automated]
    max: 1
  threat-detection: true

timeout-minutes: 10
---

# Test Threat Detection Environment Propagation

This workflow verifies that when a top-level `environment` is configured,
the compiled `detection` job inherits it.

Create an issue summarizing the provided task input.

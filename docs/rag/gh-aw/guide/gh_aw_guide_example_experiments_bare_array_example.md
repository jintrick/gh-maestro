---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-experiments-bare-array.md
original_title: test-experiments-bare-array
fetched_at: 2026-06-14T00:40:11.248292+00:00
---

---
name: Test Experiments Bare Array Form
description: Integration test workflow — validates bare-array experiment form compiles correctly
on:
  schedule:
    - cron: daily
permissions:
  contents: read
engine: copilot
experiments:
  prompt_style: [concise, verbose]
  model_temp: [low, high]
---

Bare-array experiment test.

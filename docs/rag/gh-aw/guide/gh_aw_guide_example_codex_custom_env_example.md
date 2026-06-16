---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-codex-custom-env.md
original_title: test-codex-custom-env
fetched_at: 2026-06-14T00:40:10.534346+00:00
---

---
on:
  workflow_dispatch:
permissions:
  contents: read
engine:
  id: codex
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY_CI }}
---

# Test Codex Custom Environment Variable

This is a test workflow to demonstrate how to configure custom environment variables for the Codex engine, specifically overriding the default OPENAI_API_KEY secret.

Please analyze the current repository structure and list the main directories and their purposes.
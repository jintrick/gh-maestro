---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-top-level-github-app-safe-outputs.md
original_title: test-top-level-github-app-safe-outputs
fetched_at: 2026-06-14T00:40:11.728023+00:00
---

---
on:
  issues:
    types: [opened]
permissions:
  contents: read

github-app:
  app-id: ${{ vars.APP_ID }}
  private-key: ${{ secrets.APP_PRIVATE_KEY }}
safe-outputs:
  create-issue:
    title-prefix: "[automated] "
    labels: [automation]
engine: copilot
---

# Top-Level GitHub App Fallback for Safe Outputs

This workflow demonstrates using a top-level github-app as a fallback for safe-outputs.

The top-level `github-app` is automatically applied to the safe-outputs job when no
section-specific `github-app` is defined under `safe-outputs:`.

When an issue is opened, analyze it and create a follow-up issue using the GitHub App token.

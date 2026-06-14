---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-top-level-github-app-checkout.md
original_title: test-top-level-github-app-checkout
fetched_at: 2026-06-14T00:40:11.684139+00:00
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
checkout:
  repository: myorg/private-repo
  path: private
safe-outputs:
  create-issue:
    title-prefix: "[automated] "
engine: copilot
---

# Top-Level GitHub App Fallback for Checkout

This workflow demonstrates using a top-level github-app as a fallback for checkout operations.

The top-level `github-app` is automatically applied to checkout operations that do not have
their own `github-app` or `github-token` configured.

This is useful for checking out private repositories using the GitHub App installation token.

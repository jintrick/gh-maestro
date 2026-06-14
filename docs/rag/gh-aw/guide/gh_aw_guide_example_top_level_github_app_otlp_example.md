---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-top-level-github-app-otlp.md
original_title: test-top-level-github-app-otlp
fetched_at: 2026-06-14T00:40:11.710070+00:00
---

---
on:
  issues:
    types: [opened]
permissions:
  contents: read
  issues: read
  pull-requests: read
observability:
  otlp:
    endpoint: ${{ secrets.GH_AW_OTEL_ENDPOINT }}
    github-app:
      app-id: ${{ vars.APP_ID }}
      private-key: ${{ secrets.APP_PRIVATE_KEY }}
tools:
  github:
    mode: remote
    toolsets: [default]
safe-outputs:
  create-issue:
    title-prefix: "[automated] "
engine: copilot
---

# OTLP GitHub App token minting with GitHub MCP

This workflow exercises `observability.otlp.github-app` token minting together with
`tools.github`.

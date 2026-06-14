---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/shared/otlp-github-app-import.md
original_title: otlp-github-app-import
fetched_at: 2026-06-14T00:40:11.792848+00:00
---

---
observability:
  otlp:
    endpoint: ${{ secrets.GH_AW_OTEL_ENDPOINT }}
    github-app:
      app-id: ${{ vars.APP_ID }}
      private-key: ${{ secrets.APP_PRIVATE_KEY }}
---

Shared import that defines OTLP GitHub App auth.

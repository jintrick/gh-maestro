---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-claude-wif-anthropic.md
original_title: test-claude-wif-anthropic
fetched_at: 2026-06-14T00:40:10.453562+00:00
---

---
on:
  workflow_dispatch:

permissions:
  contents: read
  id-token: write

engine:
  id: claude
  auth:
    type: github-oidc
    provider: anthropic
    federation-rule-id: fdrl_test
    organization-id: org_test
    service-account-id: svac_test
    workspace-id: ws_test

network: defaults

timeout-minutes: 5
---

# Anthropic WIF schema test

Echo "ok".

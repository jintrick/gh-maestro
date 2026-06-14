---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-firewall-default.md
original_title: test-firewall-default
fetched_at: 2026-06-14T00:40:11.285194+00:00
---

---
on: workflow_dispatch
permissions:
  contents: read
engine: copilot
network:
  allowed:
    - "example.com"
---

# Test Workflow

Test without explicit firewall config.

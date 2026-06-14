---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-copilot-gh-proxy.md
original_title: test-copilot-gh-proxy
fetched_at: 2026-06-14T00:40:10.836374+00:00
---

---
on:
  issues:
    types: [opened]
engine: copilot
permissions:
  contents: read
  issues: read
  pull-requests: read
tools:
  github:
    mode: gh-proxy
---

# Test Copilot GH Proxy

Verify that `tools.github.mode: gh-proxy` uses CLI proxy guidance and does not register GitHub MCP.

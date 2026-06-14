---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-sandbox-model-fallback.md
original_title: test-sandbox-model-fallback
fetched_at: 2026-06-14T00:40:11.514108+00:00
---

---
name: Test Sandbox Model Fallback
on:
  workflow_dispatch:
permissions:
  contents: read
engine: copilot
sandbox:
  agent:
    id: awf
    model-fallback: false
---

# Test Sandbox Model Fallback

Verify that sandbox.agent.model-fallback compiles into the AWF config JSON.

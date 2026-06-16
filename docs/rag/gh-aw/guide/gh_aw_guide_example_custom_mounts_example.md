---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-custom-mounts.md
original_title: test-custom-mounts
fetched_at: 2026-06-14T00:40:11.231338+00:00
---

---
name: Test Custom Mounts
on: workflow_dispatch
engine: copilot
sandbox:
  agent:
    id: awf
    mounts:
      - "/host/data:/data:ro"
      - "/usr/local/bin/custom-tool:/usr/local/bin/custom-tool:ro"
network:
  allowed:
    - defaults
---

Test workflow to verify custom mounts configuration.

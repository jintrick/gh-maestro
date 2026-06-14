---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-copilot-stop-time.md
original_title: test-copilot-stop-time
fetched_at: 2026-06-14T00:40:11.108666+00:00
---

---
on:
  workflow_dispatch:
  stop-after: "+48h"
permissions:
  contents: read
engine: copilot
---

# Test Copilot Stop-Time

This is a test workflow to verify stop-time safety checks with Copilot engine.

The workflow has a stop-after configuration that should create a dedicated stop_time_check job
with actions:write permission to disable the workflow if the deadline is reached.

Please analyze the current repository state and provide a brief summary.

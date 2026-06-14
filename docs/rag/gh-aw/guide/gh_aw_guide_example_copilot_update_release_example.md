---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-copilot-update-release.md
original_title: test-copilot-update-release
fetched_at: 2026-06-14T00:40:11.191444+00:00
---

---
on:
  workflow_dispatch:
permissions:
  contents: read
  actions: read
engine: copilot
safe-outputs:
  update-release:
    max: 1
timeout-minutes: 5
---

# Test Copilot Update Release

Test the update-release safe output with the Copilot engine.

Find the latest release in this repository and update its description using the **append** operation.

Add this content to the release notes:

## Test Update from Copilot

This section was added by an automated test workflow to verify the update-release functionality.

**Test Information:**
- Engine: Copilot
- Operation: append
- Timestamp: Current date and time

Output as JSONL format:
```
{"type": "update_release", "tag": "<tag-name>", "operation": "append", "body": "<content>"}
```

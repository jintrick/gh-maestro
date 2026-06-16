---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-claude-update-release.md
original_title: test-claude-update-release
fetched_at: 2026-06-14T00:40:10.442591+00:00
---

---
on:
  workflow_dispatch:
permissions:
  contents: read
  actions: read
engine: claude
safe-outputs:
  update-release:
    max: 1
timeout-minutes: 5
---

# Test Claude Update Release

Test the update-release safe output with the Claude engine.

Find the latest release in this repository and update its description using the **append** operation.

Add this content to the release notes:

## Test Update from Claude

This section was added by an automated test workflow to verify the update-release functionality.

**Test Details:**
- Engine: Claude
- Operation: append
- Timestamp: Current date and time

Output as JSONL format:
```
{"type": "update_release", "tag": "<tag-name>", "operation": "append", "body": "<content>"}
```

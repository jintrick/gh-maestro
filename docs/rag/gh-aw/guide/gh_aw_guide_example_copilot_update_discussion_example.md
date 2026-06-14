---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-copilot-update-discussion.md
original_title: test-copilot-update-discussion
fetched_at: 2026-06-14T00:40:11.144570+00:00
---

---
on:
  workflow_dispatch:
permissions:
  contents: read
  actions: read
engine: copilot
safe-outputs:
  update-discussion:
    max: 1
timeout-minutes: 5
---

# Test Copilot Update Discussion

Test the update-discussion safe output with the Copilot engine.

Find discussion #1 in this repository and update it.

Change the title to "Updated Discussion Title (Copilot Test)" and update the body to include this content:

## Test Update from Copilot

This discussion was updated by an automated test workflow to verify the update-discussion functionality.

**Test Information:**
- Engine: Copilot
- Test type: Safe output validation
- Timestamp: Test execution time

Output as JSONL format:
```
{"type": "update_discussion", "discussion_number": 1, "title": "Updated Discussion Title (Copilot Test)", "body": "<your-content>"}
```

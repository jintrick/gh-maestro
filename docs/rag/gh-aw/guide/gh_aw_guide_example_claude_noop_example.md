---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-claude-noop.md
original_title: test-claude-noop
fetched_at: 2026-06-14T00:40:10.348070+00:00
---

---
on:
  slash_command:
    name: test-noop
  reaction: eyes
permissions:
  contents: read
  actions: read
  issues: read
  pull-requests: read
engine: claude
safe-outputs:
  noop:
    max: 5
timeout-minutes: 5
---

# Test No-Op Safe Output

Test the noop safe output functionality.

Create noop outputs with transparency messages:
- "Analysis complete - no issues found"
- "Code review passed - all checks successful"
- "No changes needed - everything looks good"

Output as JSONL format.

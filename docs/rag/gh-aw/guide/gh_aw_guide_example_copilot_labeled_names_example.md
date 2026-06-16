---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-copilot-labeled-names.md
original_title: test-copilot-labeled-names
fetched_at: 2026-06-14T00:40:10.869792+00:00
---

---
on:
  issues:
    types: [labeled]
    names: [priority-high, urgent, P0]
permissions:
  contents: read
  actions: read
safe-outputs:
  add-comment:
    max: 1
engine: copilot
---

# Test Copilot Labeled Names Filter

This workflow tests label name filtering with Copilot for labeled events only.

When a priority-high, urgent, or P0 label is added to an issue, acknowledge the priority escalation with a comment.

Your comment should:
- Acknowledge the high-priority label that was added
- Suggest next steps for urgent handling
- Keep the response brief and actionable

---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-claude-labeled-names-pr.md
original_title: test-claude-labeled-names-pr
fetched_at: 2026-06-14T00:40:10.271276+00:00
---

---
on:
  pull_request:
    types: [labeled, unlabeled]
    names: [ready-for-review, needs-changes, approved]
permissions:
  contents: read
  actions: read
safe-outputs:
  add-comment:
    max: 1
engine: claude
---

# Test Claude PR Labeled Names Filter

This workflow tests label name filtering for pull request labeled/unlabeled events.

When a ready-for-review, needs-changes, or approved label is added or removed from a PR, provide a brief status comment.

Include:
- The label that changed
- Whether it was added or removed
- Appropriate next steps based on the label state

---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-claude-labeled-names.md
original_title: test-claude-labeled-names
fetched_at: 2026-06-14T00:40:10.281250+00:00
---

---
on:
  issues:
    types: [labeled, unlabeled]
    names: [bug, critical, security]
permissions:
  contents: read
  actions: read
safe-outputs:
  add-comment:
    max: 1
engine: claude
---

# Test Claude Labeled Names Filter

This workflow tests label name filtering for labeled/unlabeled events.

When a bug, critical, or security label is added or removed from an issue, analyze the label change and provide a brief status update in a comment.

Include in your comment:
- Which label was added or removed
- Whether this was a labeled or unlabeled action
- A brief note about the significance of this label

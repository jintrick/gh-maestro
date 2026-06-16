---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-codex-labeled-names.md
original_title: test-codex-labeled-names
fetched_at: 2026-06-14T00:40:10.559279+00:00
---

---
on:
  issues:
    types: [labeled, unlabeled]
    names: [enhancement, feature, needs-review]
permissions:
  contents: read
  actions: read
safe-outputs:
  add-comment:
    max: 1
engine: codex
---

# Test Codex Labeled Names Filter

This workflow tests label name filtering with Codex for labeled/unlabeled events.

When an enhancement, feature, or needs-review label is added or removed, provide feedback on the label change.

Comment should mention:
- The label that triggered this workflow
- The action type (labeled or unlabeled)
- A short suggestion related to this label change

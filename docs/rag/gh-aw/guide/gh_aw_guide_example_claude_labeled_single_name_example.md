---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-claude-labeled-single-name.md
original_title: test-claude-labeled-single-name
fetched_at: 2026-06-14T00:40:10.289228+00:00
---

---
on:
  issues:
    types: [labeled]
    names: documentation
permissions:
  contents: read
  actions: read
safe-outputs:
  add-comment:
    max: 1
engine: claude
---

# Test Claude Single Label Name Filter

This workflow tests label name filtering with a single label name (string format instead of array).

When the documentation label is added to an issue, provide guidance on documentation best practices.

Your comment should:
- Acknowledge the documentation label
- Provide 2-3 tips for good documentation
- Keep it concise and helpful

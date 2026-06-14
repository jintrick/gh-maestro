---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-copilot-safe-output-actions.md
original_title: test-copilot-safe-output-actions
fetched_at: 2026-06-14T00:40:11.082735+00:00
---

---
on:
  workflow_dispatch:
permissions:
  contents: read
  pull-requests: read
engine: copilot
safe-outputs:
  actions:
    add-smoked-label:
      uses: actions-ecosystem/action-add-labels@v1
      description: Add the 'smoked' label to the current pull request
      env:
        GITHUB_TOKEN: ${{ github.token }}
---

# Test Safe Output Actions

This workflow demonstrates `safe-outputs.actions`, which mounts a GitHub Action
as a once-callable MCP tool.

When done, call `add_smoked_label` with `{"labels": "smoked"}` to add the label
to the current pull request.

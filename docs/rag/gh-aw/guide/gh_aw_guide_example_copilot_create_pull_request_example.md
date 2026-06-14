---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-copilot-create-pull-request.md
original_title: test-copilot-create-pull-request
fetched_at: 2026-06-14T00:40:10.801467+00:00
---

---
on:
  workflow_dispatch:
permissions:
  pull-requests: read
  contents: read
engine: copilot
---

# Test Copilot Create Pull Request

This is a test workflow to verify that Copilot can create new pull requests.

Please create a new pull request that:
1. Creates a new branch called "test-branch"
2. Adds a simple README.md change
3. Creates a PR with the title "Test PR from Copilot"
4. Includes a proper description explaining this is a test PR
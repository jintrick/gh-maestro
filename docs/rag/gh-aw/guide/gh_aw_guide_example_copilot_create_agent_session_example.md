---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-copilot-create-agent-session.md
original_title: test-copilot-create-agent-session
fetched_at: 2026-06-14T00:40:10.721849+00:00
---

---
on: workflow_dispatch
permissions:
  contents: read
engine: copilot
safe-outputs:
  create-agent-session:
    base: main
---

# Test: Create Agent Task

Test workflow for the create-agent-session safe output.

Create a GitHub Copilot coding agent session to improve code quality in the repository.

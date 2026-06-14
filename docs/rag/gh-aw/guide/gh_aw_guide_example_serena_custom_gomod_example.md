---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-serena-custom-gomod.md
original_title: test-serena-custom-gomod
fetched_at: 2026-06-14T00:40:11.531064+00:00
---

---
on: workflow_dispatch
engine: copilot
permissions:
  contents: read
tools:
  serena:
    languages:
      go:
        go-mod-file: "backend/go.mod"
        gopls-version: "latest"
strict: false
---

# Test Serena Custom Go.mod Path

Test workflow to verify Serena with custom go.mod file path.

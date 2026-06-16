---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-serena-go-config.md
original_title: test-serena-go-config
fetched_at: 2026-06-14T00:40:11.540039+00:00
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
        version: "1.21"
        go-mod-file: "go.mod"
        gopls-version: "v0.14.2"
strict: false
---

# Test Serena Go Configuration

Test workflow to verify Serena Go configuration with custom go version, go.mod file location, and gopls version.

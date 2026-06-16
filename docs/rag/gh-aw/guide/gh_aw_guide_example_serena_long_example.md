---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-serena-long.md
original_title: test-serena-long
fetched_at: 2026-06-14T00:40:11.548018+00:00
---

---
on: workflow_dispatch
engine: copilot
permissions:
  contents: read
tools:
  serena:
    version: latest
    args: ["--verbose"]
    languages:
      go:
        version: "1.21"
        go-mod-file: "go.mod"
        gopls-version: "v0.14.2"
      typescript:
      python:
        version: "3.12"
strict: false
---

# Test Serena Long Syntax

Test workflow to verify Serena MCP with long syntax (detailed configuration including Go version, go.mod path, and gopls version).

---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-codex-github-remote-mcp.md
original_title: test-codex-github-remote-mcp
fetched_at: 2026-06-14T00:40:10.542324+00:00
---

---
on:
  workflow_dispatch:
permissions:
  contents: read
engine: codex
tools:
  github:
    mode: remote
    allowed: [get_repository, list_issues, issue_read]
---

# Test Codex with GitHub Remote MCP

This is a test workflow to verify Codex's ability to use the hosted GitHub MCP server in remote mode.

Please use the remote GitHub MCP server to:
1. Get information about this repository (github/gh-aw)
2. List the first 3 open issues
3. Get details for issue #1 if it exists

The workflow uses `mode: remote` to connect to the hosted GitHub MCP server at https://api.githubcopilot.com/mcp/ with GH_AW_GITHUB_TOKEN for authentication.

---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-mcp-imports.md
original_title: test-mcp-imports
fetched_at: 2026-06-14T00:40:11.387446+00:00
---

---
on: issues
permissions:
  contents: read
  issues: read
engine: copilot

imports:
  - shared/mcp/test-server.md

tools:
  github:
    allowed: ["get_repository", "list_commits"]
---

# Test MCP Imports

This workflow imports shared MCP server configuration to test that `mcp inspect` properly processes imports.

The workflow should have access to both the github MCP server (defined here) and any MCP servers imported from shared files.

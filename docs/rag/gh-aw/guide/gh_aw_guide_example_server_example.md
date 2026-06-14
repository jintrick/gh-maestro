---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/shared/mcp/test-server.md
original_title: test-server
fetched_at: 2026-06-14T00:40:11.842246+00:00
---

---
mcp-servers:
  test-mcp-server:
    command: "node"
    args: ["test-server.js"]
    allowed: ["test_tool_1", "test_tool_2"]
---

This file provides a test MCP server configuration for testing imports.

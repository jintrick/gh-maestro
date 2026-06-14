---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-claude-mcps-custom.md
original_title: test-claude-mcps-custom
fetched_at: 2026-06-14T00:40:10.325132+00:00
---

---
on: issues
permissions:
  contents: read
  issues: read
engine: claude
mcp-servers:
  # New direct field format - stdio with command
  my-stdio-server:
    command: npx
    args: ["-y", "my-server"]
    registry: "https://registry.example.com/servers/my-stdio-server"
    allowed: ["process_data", "get_info"]
    

  # New direct field format - http with url
  my-http-server:
    url: "https://api.example.com/mcp"
    headers:
      Authorization: "Bearer ${{ secrets.API_TOKEN }}"
    registry: "https://registry.example.com/servers/my-http-server"
    allowed: ["fetch_data"]
    
  # Type inference - local type alias
  local-server:
    type: local
    command: "local-tool"
    args: ["--local"]
    allowed: ["local_action"]
    
  # Type inference - no type specified, inferred from command
  inferred-stdio:
    command: "inferred-server"
    args: ["--mode", "stdio"]
    allowed: ["inferred_tool"]
    
  # Type inference - no type specified, inferred from url  
  inferred-http:
    url: "https://inferred.api.com/mcp"
    allowed: ["inferred_http_tool"]
---

# Test Workflow

Test workflow with new MCP configuration format.

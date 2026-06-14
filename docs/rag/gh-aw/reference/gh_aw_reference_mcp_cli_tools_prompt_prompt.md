---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/actions/setup/md/mcp_cli_tools_prompt.md
original_title: mcp_cli_tools_prompt
fetched_at: 2026-06-14T00:40:04.210887+00:00
---

<mcp-clis>
CLI servers are available on `PATH`:
__GH_AW_MCP_CLI_SERVERS_LIST__
Use `<server> --help` for tool names, parameters, and examples before calling any command.
To pass many arguments safely, pipe a JSON object on stdin with `printf` and pass `.` as the payload sentinel: `printf '%s\n' '{"param":"value","count":1}' | <server> <tool> .`
</mcp-clis>

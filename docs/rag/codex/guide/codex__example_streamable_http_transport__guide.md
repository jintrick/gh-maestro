---
source_url: https://developers.openai.com/codex/llms-full.txt
original_title: --- Example: Streamable HTTP transport ---
fetched_at: 2026-07-03T06:05:55.863Z
---

# --- Example: Streamable HTTP transport ---

# [mcp_servers.github]

# enabled = true # optional; default true

# required = true # optional; fail startup/resume if this server cannot initialize

# url = "https://github-mcp.example.com/mcp" # required

# bearer_token_env_var = "GITHUB_TOKEN" # optional; Authorization: Bearer <token>

# http_headers = { "X-Example" = "value" } # optional static headers

# env_http_headers = { "X-Auth" = "AUTH_ENV" } # optional headers populated from env vars

# startup_timeout_sec = 10.0 # optional

# tool_timeout_sec = 60.0 # optional

# enabled_tools = ["list_issues"] # optional allow-list

# disabled_tools = ["delete_issue"] # optional deny-list

# scopes = ["repo"] # optional OAuth scopes

################################################################################

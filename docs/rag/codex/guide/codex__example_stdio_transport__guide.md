---
source_url: https://developers.openai.com/codex/llms-full.txt
original_title: --- Example: STDIO transport ---
fetched_at: 2026-07-03T06:05:55.863Z
---

# --- Example: STDIO transport ---

# [mcp_servers.docs]

# enabled = true # optional; default true

# required = true # optional; fail startup/resume if this server cannot initialize

# command = "docs-server" # required

# args = ["--port", "4000"] # optional

# env = { "API_KEY" = "value" } # optional key/value pairs copied as-is

# env_vars = ["ANOTHER_SECRET"] # optional: forward local parent env vars

# env_vars = ["LOCAL_TOKEN", { name = "REMOTE_TOKEN", source = "remote" }]

# cwd = "/path/to/server" # optional working directory override

# experimental_environment = "remote" # experimental: run stdio via a remote executor

# startup_timeout_sec = 10.0 # optional; default 10.0 seconds

# # startup_timeout_ms = 10000 # optional alias for startup timeout (milliseconds)

# tool_timeout_sec = 60.0 # optional; default 60.0 seconds

# enabled_tools = ["search", "summarize"] # optional allow-list

# disabled_tools = ["slow-tool"] # optional deny-list (applied after allow-list)

# scopes = ["read:docs"] # optional OAuth scopes

# oauth_resource = "https://docs.example.com/" # optional OAuth resource

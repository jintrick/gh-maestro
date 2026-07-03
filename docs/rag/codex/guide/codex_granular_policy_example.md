---
source_url: https://developers.openai.com/codex/llms-full.txt
original_title: Example granular policy:
fetched_at: 2026-07-03T06:05:55.863Z
---

# Example granular policy:

# approval_policy = { granular = {

# sandbox_approval = true,

# rules = true,

# mcp_elicitations = true,

# request_permissions = false,

# skill_approval = false

# } }

# Allow login-shell semantics for shell-based tools when they request `login = true`.

# Default: true. Set false to force non-login shells and reject explicit login-shell requests.

allow_login_shell = true

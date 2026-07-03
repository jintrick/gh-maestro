---
source_url: https://developers.openai.com/codex/llms-full.txt
original_title: Optional: granular approval policy
fetched_at: 2026-07-03T06:05:55.863Z
---

# Optional: granular approval policy

# approval_policy = { granular = {
#   sandbox_approval = true,
#   rules = true,
#   mcp_elicitations = true,
#   request_permissions = false,
#   skill_approval = false
# } }
```

You can also save presets as [profile files](https://developers.openai.com/codex/config-advanced#profiles), then select them with `codex --profile profile-name`:

```toml
# ~/.codex/full_auto.config.toml
approval_policy = "on-request"
sandbox_mode    = "workspace-write"
```

```toml
# ~/.codex/readonly_quiet.config.toml
approval_policy = "never"
sandbox_mode    = "read-only"
```

### Test the sandbox locally

To see what happens when a command runs under the Codex sandbox, use these Codex CLI commands:

```bash

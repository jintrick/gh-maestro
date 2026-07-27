# Antigravity Autonomy & Permissions

The agent's ability to execute tools is governed by global autonomy levels and fine-grained command permissions.

## Command & Access Permissions (`/permissions`)
The `/permissions` command displays the active permission filters (`allow`, `deny`, `ask`) for tool execution and file access.

To automate or skip tool execution approvals:
- **CLI Startup Flag**: Use `agy --dangerously-skip-permissions` to automatically approve all tool calls without asking.
- **Autonomous Execution**: Use the `/goal <task>` command to let the agent run autonomously until task completion.
- **Fine-Grained Permissions**: Pre-approve specific commands in `~/.gemini/antigravity-cli/settings.json`.

## Fine-Grained Permissions
Power users can define specific allowed or denied commands in `~/.gemini/antigravity-cli/settings.json`:

```json
{
  "permissions": {  
    "allow": ["command(git)", "command(npm test)"],  
    "deny": ["command(rm -rf)"]  
  }
}
```

## Status Line Integration
The CLI can pipe live agent metadata (JSON format containing CWD, active model, token usage, state, etc.) into custom shell scripts to generate dynamic status bars.

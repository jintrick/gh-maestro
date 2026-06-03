# Antigravity Autonomy & Permissions

The agent's ability to execute tools is governed by global autonomy levels and fine-grained command permissions.

## Autonomy Levels (`/permissions`)
- **`request-review`**: (Default) Agent must wait for user approval for every tool call.
- **`always-proceed`**: Agent executes all tools without asking. Recommended only in sandboxed environments.
- **`strict`**: Enforces maximum adherence to rules in `.agents/rules/` (and backward-compatible `.agent/rules/`).

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

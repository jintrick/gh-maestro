# Antigravity CLI Configuration Files

Antigravity CLI uses JSON-based configuration files for global and workspace-level settings.

## Global Settings (`settings.json`)
Path: `~/.gemini/antigravity-cli/settings.json`

Key Fields:
- `colorScheme`: Theme for the TUI (e.g., `"tokyo night"`).
- `enableTerminalSandbox`: (boolean) Enables/disables OS-level process isolation.
- `permissions`: Fine-grained tool access control.
  ```json
  "permissions": {
    "allow": ["command(git)", "command(npm test)"],
    "deny": ["command(rm -rf)"]
  }
  ```

## MCP Configuration (`mcp_config.json`)
Path: `~/.gemini/antigravity/mcp_config.json` (Global) or `.agents/mcp_config.json` (Workspace).
- Stores the list of MCP servers and their transport/auth settings.

## Workspace Rules (`.agents/rules/`)
Path: `.agents/rules/*.md`
- Markdown files with YAML frontmatter defining file-specific or global constraints.
- **Trigger Type**: `glob`, `always_on`, `manual`, `model_decision`.

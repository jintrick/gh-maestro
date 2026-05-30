# Antigravity CLI Features Overview

Antigravity CLI introduces several advanced features for professional coding automation.

## Plugins
Plugins are namespaced bundles that contain:
- **Skills**: Task-specific instructions.
- **Agents**: Specialized personas.
- **Rules**: Project constraints.
- **MCP Servers**: Tool integrations.
- **Hooks**: Lifecycle interceptions.

Import existing Gemini CLI extensions using `agy plugin import gemini`.

## Terminal Sandbox
Security isolation for shell commands executed by the agent.
- **Linux**: `nsjail`.
- **macOS**: `sandbox-exec`.
- **Windows**: `AppContainer`.

## Non-Workspace Access
By default, agents are restricted to the project root and `~/.gemini/antigravity/`. This can be relaxed in settings to allow access to external files.

## Projects
Defines the boundaries of folders and repositories the agent can access. Projects maintain isolated settings and security policies. 

You can use the **`/add-dir <path>`** command to temporarily add an external directory to the current session, allowing the agent to load project-specific rules and skills from that location.

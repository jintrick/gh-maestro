# Antigravity Terminal Sandbox

The Terminal Sandbox is a lightweight security isolation mechanism that protects the host system from potentially destructive file manipulations or unauthorized outbound network requests during shell command execution.

## Technology Stack
It leverages native operating system features with zero startup overhead:
- **Linux**: `nsjail`
- **macOS**: `sandbox-exec`
- **Windows**: `AppContainer`

## Configuration
Configure sandbox behavior in `~/.gemini/antigravity-cli/settings.json`:

```json
{
  "enableTerminalSandbox": true
}
```
- **`enableTerminalSandbox`** (boolean, default: `false`): Enables general execution containment barriers on all local agent processes.

## Interactive Approvals
The CLI prompt adapts dynamically based on the sandbox state:
- **Sandbox Enabled**: The confirmation prompt includes an option to "Yes, and run without sandbox restrictions" for trusted commands.
- **Sandbox Disabled**: The prompt includes an option to "Yes, and run in sandbox" for potentially risky commands.

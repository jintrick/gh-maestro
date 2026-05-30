# Antigravity Hooks Specification

Hooks allow running custom scripts or shell commands at specific lifecycle points of the agent's execution loop.

## Configuration
Hooks are defined in `hooks.json` (Workspace: `.agents/hooks.json`, Global: `~/.gemini/config/hooks.json`).

```json
{
  "hook-name": {
    "PostToolUse": [
      {
        "matcher": "run_command",
        "hooks": [
          {
            "type": "command",
            "command": "./scripts/lint.sh",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

## Supported Events

| Event | Trigger Point | Matcher Target |
| :--- | :--- | :--- |
| **PreToolUse** | Before a tool is executed | Tool name (e.g., `run_command`) |
| **PostToolUse** | After a tool completes | Tool name |
| **PreInvocation** | Before the model is called | N/A (Matcher ignored) |
| **PostInvocation** | After tool calls finish | N/A |
| **Stop** | When execution loop terminates | N/A |

## Common Metadata (stdin)
All hooks receive a JSON payload containing:
- `conversationId`: UUID of the session.
- `workspacePaths`: Mounted directories.
- `transcriptPath`: Path to `transcript.jsonl`.
- `artifactDirectoryPath`: Path for screenshots and results.

## Event Schema Highlights

### PreToolUse Decision
The hook can return a `decision` to gate tool execution:
- `allow`: Auto-execute.
- `deny`: Block execution.
- `ask`: Prompt user.
- `force_ask`: Always prompt user.

### Injected Steps (Invocation Events)
Hooks can return `injectSteps` to modify the conversation trajectory:
- `toolCall`: Execute a tool.
- `userMessage`: Add a user prompt.
- `ephemeralMessage`: Add a transient system message.

## Supported Tools for Matchers
- **File**: `view_file`, `write_to_file`, `replace_file_content`, `multi_replace_file_content`, `list_dir`, `find_by_name`.
- **System**: `run_command`, `manage_task`, `schedule`, `list_permissions`, `ask_permission`.
- **Collaboration**: `invoke_subagent`, `define_subagent`, `send_message`, `manage_subagents`.
- **Media**: `ask_question`, `generate_image`.

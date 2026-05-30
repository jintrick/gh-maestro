# Antigravity Strict Mode

Strict mode provides enhanced security controls, allowing you to restrict the Agent's access to external resources and sensitive operations.

## Features

### Browser URL Allowlist/Denylist
The Agent's ability to interact with external websites is governed by the browser's Allowlist/Denylist:
- **External Markdown Images**: Only images from allowed URLs are rendered.
- **Read URL Tool**: Will only auto-execute for allowed URLs.

### Interaction Policies
Strict mode enforces the following overrides:
- **Terminal Auto Execution**: Forced to `"Request Review"`. The agent always prompts for permission before running bash commands (ignoring the terminal allowlist).
- **Browser Javascript Execution**: Forced to `"Request Review"`.
- **Artifact Review**: Forced to `"Request Review"`. The agent will always prompt before acting on generated plans.

### File System Access
- **Respect `.gitignore`**: The agent strictly respects `.gitignore` rules and cannot access ignored files.
- **Workspace Isolation**: Access to files outside the designated workspace is completely disabled.

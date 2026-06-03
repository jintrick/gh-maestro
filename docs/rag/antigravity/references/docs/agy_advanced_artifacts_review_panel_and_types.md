# Antigravity Artifact Review

Artifacts are structured outputs produced by the agent during a task (Implementation Plans, Code Diffs, Screenshots, etc.).

## Common Artifact Types
- **Implementation Plan**: Technical design of changes, requiring user approval.
- **Task List**: Markdown list for monitoring complex progress.
- **Walkthrough**: Summary of completed work, often with visual evidence.
- **Code Change**: Proposed file modifications.

## Review Flow (CLI)
- **Review Panel**: Use the **`/artifact`** command to explicitly open the review panel. The CLI uses a keyboard-driven panel to display and approve artifacts.
- **Inline Feedback**: You can add comments directly to specific parts of a plan to steer the agent.
- **Proceed**: Use the designated hotkey (e.g., `Shift+Tab`) or button to approve and execute.

## Policies
- **`request-review`**: (Default) Agent stops for manual approval before acting on artifacts.
- **`always-proceed`**: Agent executes without stopping.
- **`strict`**: Enforces strict adherence to rules in `.agents/rules/`.

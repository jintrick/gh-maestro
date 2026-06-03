# Antigravity Subagents & Coordination

Subagents parallelize complex tasks and preserve the main agent's context window by offloading work to dedicated sessions.

## Invoking Subagents
The parent agent uses the `invoke_subagent` tool.
- **Workspace**: Can inherit the parent's workspace or create an isolated Git worktree.
- **Context**: Starts with a clean conversation history.
- **Model**: Inherits the model of the parent.

## Subagent Lifecycle States
1. **Running**: Actively executing. Can be canceled via UI, interrupted by parent, or killed.
2. **Idle**: Task completed, results sent. Can be re-awakened with context retention.
3. **Killed**: Permanently terminated. Worktrees cleaned up.

## Built-In Subagents
- **research**: Optimized for codebase exploration and navigation.
- **browser**: Operates sandboxed browsers (exclusive to `/browser` command).
- **self**: A direct clone of the calling agent's prompt and tools.

## Coordination & Routing
- **Routing**: Agents can message parents, subagents, or any active agent with a known ID.
- **Shared Transcripts**: Agents can view each other's conversation history for better collaboration.

## Limits
- **Nesting Limit**: Maximum depth of **10 levels**.
- **Inherited Permissions**: Subagents inherit the parent's terminal and file scopes. Permission requests bubble up to the UI.

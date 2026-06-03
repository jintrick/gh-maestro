# Antigravity New Worktree Mode

Isolated Git Worktrees allow agents to perform invasive changes or run destructive tests without polluting the user's active branch or directory.

## Isolation Mechanics
- When invoked (via `/fork` or `invoke_subagent`), the agent creates a temporary `git worktree` in a separate directory (managed in `~/.gemini/antigravity/worktrees/`).
- **Clean Slate**: The agent operates on a fresh copy of the code, preventing "dirty" workspace artifacts from interfering with reasoning.
- **Safety**: Errors in implementing refactors won't break the user's current environment.

## Commit & Merge
Once the task in the worktree is complete, the agent can:
1. Provide a final diff for the user to merge.
2. Automatically commit and push to a remote branch for PR review.
3. Clean up the worktree directory upon session termination.

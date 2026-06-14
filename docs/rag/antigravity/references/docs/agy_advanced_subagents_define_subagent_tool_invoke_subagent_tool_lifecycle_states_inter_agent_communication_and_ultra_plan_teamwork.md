---
source_url: https://antigravity.google/docs/subagents
original_title: Asynchronous Subagents
fetched_at: 2026-06-10
---

# Antigravity Asynchronous Subagents: Complete Reference

Subagents parallelize complex tasks and preserve the main agent's context window by offloading work to dedicated sessions. Instead of executing every step serially, an agent can delegate tasks to subagents, freeing the parent agent to continue working in parallel.

## Invoking Subagents

The parent agent calls the `invoke_subagent` tool to spawn a new concurrent session with a dedicated role and initial prompt.

- **Workspace Options**: The subagent can either inherit the same workspace as its parent or create an isolated Git worktree.
- **Context Isolation**: The subagent runs using the same model as its parent but does **not** inherit the parent's existing conversation history, starting with a clean slate.
- **Execution**: Once invoked, the subagent immediately begins executing its task. A parent agent can invoke multiple subagents at any time.
- **Monitoring**: Progress can be monitored directly by clicking into the subagent's conversation via the subagent panel.

## Subagent Lifecycle States

Subagents run asynchronously in the background.

### 1. Running
The subagent is actively executing its task, calling tools, and generating responses.
- **Cancellation**: Click the Stop Subagent button in the subagent panel. Transitions to Idle.
- **Parent Control**: The parent agent can also interrupt (by sending a message) or kill a subagent.

### 2. Idle
The subagent has completed its task, sent results to the parent, and stopped execution.
- **Re-awakening**: An idle agent can be re-awakened by receiving a message from any agent (not just its parent). Returns to Running state.
- **Context Retention**: When awoken, all prior context is retained.

### 3. Killed
Permanently terminated. Cannot be re-awakened.
- **Cleanup**: Temporary Git worktrees are automatically cleaned up.
- **Visibility**: Historical conversation transcript remains viewable by agents and users.

## Inter-Agent Communication

Agents communicate using unique agent IDs.

- **Flexible Routing**: Agents can message not only their direct parents or subagents, but any active agent whose ID is known.
- **Auto-Wake**: An idle agent receiving a message is automatically re-awakened to process it.
- **Shared Transcripts**: Agents can view each other's conversation transcripts for a comprehensive view of the collaborative workflow.

## Built-In vs. Custom Subagents

### Built-In Subagents

| Name | Description |
| :--- | :--- |
| `research` | Optimized for codebase research, navigation, and exploration. |
| `browser` | Operates sandboxed web browsers (invoked exclusively via `/browser`). |
| `self` | A direct clone of the calling agent, sharing identical system prompt and toolsets. |

### Custom Subagents: `define_subagent` Tool

Agents define their own custom subagents dynamically using the **`define_subagent`** tool.

- **Configuration**: Define a custom system prompt and specific toolsets for:
  - Read-only capabilities
  - Write capabilities (including running terminal commands)
  - Subagent delegation capabilities
- **Scope**: Once defined, the custom subagent can be **invoked repeatedly** for the remainder of the conversation.

## Delegation Hierarchy and Limits

Subagents can invoke their own subagents, enabling multiple layers of delegation and hierarchical team structures.

- **Nesting Depth Limit**: Maximum **10 levels** strictly enforced to prevent runaway resource exhaustion.

## Permissions and Configuration Inheritance

- **Inherited Scopes**: Subagents automatically inherit the parent's allowed terminal command prefixes and file read/write directory scopes. A subagent cannot perform any action the user has not already approved for the parent.
- **Workspace Access**: Parent agents retain full access to subagents' workspaces, including those on isolated Git worktrees.
- **Permission Bubbling**: If a subagent encounters a tool call requiring explicit user confirmation, the request is automatically bubbled up to the subagent panel UI.

## Multi-Agent Teamwork (Ultra Plan Only)

The `/teamwork-preview` slash command launches advanced multi-agent orchestration for extremely complex tasks. Features built-in error recovery, automatic retries, and coordination logic. Exclusive to the Ultra ($200/mo) plan.

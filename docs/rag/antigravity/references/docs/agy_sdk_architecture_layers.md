# Antigravity SDK: Architecture Layers

The Antigravity SDK is built on a three-layer architecture to ensure a clear separation of concerns between configuration, session state, and transport.

## Layer 1: Agent (Lifecycle & Configuration)
The **Agent** class is the high-level entry point for most users. It owns the declarative setup of the agentic session.

- **Responsibilities**:
    - Storing `AgentConfig` (e.g., model selection, capability settings).
    - Managing the `HookRunner` (lifecycle interception).
    - Managing the `ToolRunner` (registry for Python/MCP tools).
    - Orchestrating the `chat()` loop (reasoning → tool execution → error recovery).

## Layer 2: Conversation (Session State)
The **Conversation** class manages the stateful interaction with the backend. It wraps a Connection and adds history-tracking features.

- **Responsibilities**:
    - **History Management**: Recording all `Step` objects.
    - **Token Usage**: Tracking cumulative and per-turn token consumption.
    - **Turn Tracking**: Identifying boundaries between user prompts and model responses.
    - **Compaction**: Tracking when the model's context window was compacted.
- **When to use**: Use `agent.conversation` when you need to inspect history, manually manage turns (`send()`/`receive_steps()`), or track costs.

## Layer 3: Connection (Transport)
The **Connection** is an abstract base class representing a live wire-session. It decouples the SDK from the specific binary or network protocol.

- **Responsibilities**:
    - **Protocol Handling**: Serializing messages (usually Protobuf/JSON).
    - **Binary Lifecycle**: Starting/stopping the local harness or connecting to remote hosts.
    - **Turn Control**: Canceling active turns or monitoring idle state.
- **Implementation**: The default implementation is `LocalConnection`, which communicates with a Go-based local harness via WebSockets.

## Hierarchical Relationship
```text
┌──────────────────────────────────────────────┐
│  Agent  (Layer 1 — Lifecycle & Config)       │
│  Owns: config, hooks, triggers, policies,    │
│        MCP bridges, tool runner, chat()      │
│                                              │
│  ┌──────────────────────────────────────────┐│
│  │  Conversation  (Layer 2 — Session)       ││
│  │  Owns: history, turn tracking,           ││
│  │        compaction indices, usage,        ││
│  │        send(), receive_steps(), chat()   ││
│  │                                          ││
│  │  ┌──────────────────────────────────────┐││
│  │  │  Connection  (Layer 3 — Transport)   │││
│  │  │  Owns: wire protocol, binary,        │││
│  │  │        idle/wakeup, disconnect       │││
│  │  └──────────────────────────────────────┘││
│  └──────────────────────────────────────────┘│
└──────────────────────────────────────────────┘
```

---
*Reference: google-antigravity/antigravity-sdk-python/google/antigravity/conversation/README.md*

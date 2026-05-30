# Antigravity SDK: Tools & MCP Integration

The `tools` package manages the discovery and execution of in-process and external capabilities.

## ToolRunner
`ToolRunner` is the registry for all Python tools. It handles:
- **Async/Sync Detection**: Runs synchronous functions in a separate thread to keep the event loop responsive.
- **Batch Processing**: Executing multiple tool calls in parallel when requested by the model.
- **ToolContext Injection**: Automatically injects a `ToolContext` into functions that define it in their signature.

## Types of Tools
1.  **Built-in Tools**: Core capabilities provided by the harness (e.g., `list_dir`, `grep_search`).
2.  **Custom Python Functions**: Any Python callable. Use docstrings to provide tool descriptions to the model.
3.  **MCP Servers**: Model Context Protocol servers connected via stdio, SSE, or HTTP.
4.  **Agent Skills**: Reusable packages containing instructions and multiple tools.

## Disabling vs. Denying Tools
| Mechanism | Level | Model Awareness | Best For |
| :--- | :--- | :--- | :--- |
| **CapabilitiesConfig** | Harness | **No** (Hidden) | Irrelevant tools (prevents token waste). |
| **policy.deny()** | Hook | **Yes** (Visible) | Conditional/Argument-dependent restrictions. |

**Guideline**: Use `CapabilitiesConfig` to strip tools the agent should *never* need. Use policies for runtime guardrails where the decision depends on arguments (e.g., blocking `rm -rf`).

## ToolContext & Session State
Tools can maintain state across a conversation using `ToolContext`:
- **`get_state(key)` / `set_state(key, value)`**: Store pagination cursors, temporary results, or scratchpads.
- **Persistence**: State is scoped to the `Conversation` session.
- **Isolation**: Tool state is **not** accessible to Lifecycle Hooks.

## Registration Example
```python
def my_tool(ctx: ToolContext, query: str) -> str:
    """Search my internal database."""
    # Use ctx.connection for metadata or ctx.get_state() for caching
    return "Result"

runner = ToolRunner(tools=[my_tool])
```

---
*Reference: google-antigravity/antigravity-sdk-python/google/antigravity/tools/README.md*

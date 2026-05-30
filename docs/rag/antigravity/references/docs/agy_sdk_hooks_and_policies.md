# Antigravity SDK: Hooks & Safety Policies

Hooks and Policies provide a secure, symmetrical lifecycle for intercepting and governing agent behavior.

## Hook Taxonomy
Hooks are classified into three categories based on their impact on the execution flow:

1.  **Inspect Hooks** (Read-Only, Non-Blocking):
    - **Purpose**: Logging, metrics, audit trails.
    - **Behavior**: Cannot modify data or block execution. Executed concurrently.
2.  **Decide Hooks** (Read-Only, Blocking):
    - **Purpose**: Policy enforcement, permission checks.
    - **Behavior**: Returns `HookResult(allow=True/False)`. Aborts immediately if denied.
3.  **Transform Hooks** (Modifying, Blocking):
    - **Purpose**: Data sanitization, prompt optimization, recovery.
    - **Behavior**: Can modify data before it reaches the target.

## Declarative Safety Policies
The SDK provides a `policy` module for "deny by default" tool governance. Policies are converted into `PreToolCallDecideHooks`.

```python
from google.antigravity.hooks import policy

policies = [
    policy.deny("*"),                       # Block everything by default
    policy.allow("view_file"),              # Except reading files
    policy.deny("run_command",              # Block specific patterns
        when=lambda args: "rm" in args.get("CommandLine", "")),
    policy.ask_user("run_command",          # Require human approval
        handler=my_approval_fn),
]

agent = Agent(config, hooks=HookRunner(pre_tool_call_decide_hooks=[policy.enforce(policies)]))
```

### Policy Priority Model (1-6)
1.  **Specific + DENY**: `deny("run_command")`
2.  **Specific + ASK_USER**: `ask_user("run_command", ...)`
3.  **Specific + APPROVE**: `allow("run_command")`
4.  **Wildcard + DENY**: `deny("*")`
5.  **Wildcard + ASK_USER**: `ask_user("*", ...)`
6.  **Wildcard + APPROVE**: `allow("*")`

## Hierarchical Context
Hooks share state via a hierarchical context system:
- **SessionContext**: Persists for the entire life of the `Agent`.
- **TurnContext**: Scoped to one user prompt/response cycle.
- **OperationContext**: Scoped to a specific tool or model call.

**Security Note**: `HookContext` and `ToolContext` are completely isolated. Hooks cannot access tool state, and vice-versa, preventing TOCTOU vulnerabilities and cross-talk.

## Execution Order
1. **Decide Hooks**: Validates the request (Deny/Approve).
2. **Transform Hooks**: Sanitizes the data.
3. **Execution**: The tool or model is called.
4. **Inspect Hooks**: Logs the actual outcome.

---
*Reference: google-antigravity/antigravity-sdk-python/google/antigravity/hooks/README.md*

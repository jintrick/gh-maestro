# Antigravity SDK: Triggers & Background Events

Triggers are long-lived async functions that run alongside an agent session. They are used to inject external events into the agent's conversation.

## Hooks vs. Triggers
| Concept | Hooks | Triggers |
| :--- | :--- | :--- |
| **Lifetime** | Single dispatch point | Entire session |
| **Execution** | Inline, blocking | Background, async |
| **Purpose** | React to agent lifecycle | React to external events |
| **Capability** | Can block/modify flow | Can only send messages |

## Trigger Definition
A Trigger is an `async` function that accepts a `TriggerContext`. Use the `@trigger` decorator for discovery.

```python
from google.antigravity.triggers import triggers

@triggers.trigger
async def cron_checker(ctx: triggers.TriggerContext):
    while True:
        await asyncio.sleep(3600)
        await ctx.send("Check if any scheduled tasks are due.")
```

## Helper Factories
The SDK provides built-in helpers for common event types:

1.  **`every(seconds, callback)`**: Runs a function at a fixed interval.
2.  **`on_file_change(path, callback)`**: Reacts to OS-level filesystem changes (ADDED, MODIFIED, DELETED).

## TriggerRunner
The `TriggerRunner` manages the lifecycle of all registered triggers.
- **Async Context Manager**: Best used with `async with TriggerRunner(...)` to ensure triggers are stopped when the agent session ends.
- **Isolation**: An exception in one trigger does not crash the others or the main agent session.
- **No Ordering**: Triggers are independent background tasks.

---
*Reference: google-antigravity/antigravity-sdk-python/google/antigravity/triggers/README.md*

# Antigravity SDK: Overview & Quick Start

The Antigravity SDK is a programmatic Python framework designed to build, test, and run autonomous AI agents. It extends the same core agent harness that powers the Antigravity CLI and Antigravity 2.0, allowing you to integrate advanced agentic capabilities directly into your own applications and workflows.

## Key Philosophy
The SDK decouples your agent's logic from where it runs, allowing you to focus on what the agent does; the SDK handles how and where it executes (local, remote, or sandboxed).

## Installation
Install the SDK using pip:

```bash
pip install google-antigravity
```

## Hello World Example
A functional agent that can interact with your local environment in under 15 lines of Python:

```python
import asyncio
from google.antigravity import Agent, LocalAgentConfig

async def main():
    # LocalAgentConfig points to the local binary harness
    config = LocalAgentConfig()
    
    async with Agent(config) as agent:
        # chat() handles the entire reasoning/execution loop automatically
        response = await agent.chat("What files are in the current directory?")
        print(await response.text())

if __name__ == "__main__":
    asyncio.run(main())
```

## Core Pillars
1. **Governed Extensibility (Tools)**: Built-in tools, Custom Python functions, MCP Servers, and reusable Skills.
2. **Declarative Safety Policies**: A "deny by default" policy system to control tool execution.
3. **Lifecycle Hooks**: Nine concrete lifecycle points across three categories (Inspect, Decide, Transform).

## Main Entry Points
- **`Agent`**: The high-level Layer 1 API. Manages config, hooks, tools, and the chat loop.
- **`Conversation`**: The stateful Layer 2 API. Manages history, token usage, and turn tracking.
- **`Connection`**: The Layer 3 transport API. Handles the wire protocol (WebSockets/Protobuf).

---
*Reference: https://antigravity.google/docs/sdk-overview*

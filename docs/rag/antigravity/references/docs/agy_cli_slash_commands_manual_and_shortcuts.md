# Antigravity CLI Slash Commands

Antigravity CLI supports slash commands typed directly into the prompt box to manage conversations, settings, and agent capabilities.

## Core Slash Commands

| Command | Category | Purpose |
| :--- | :--- | :--- |
| `/add-dir <path>` | Tools & Monitoring | Register additional workspace directories to load rules and skills. |
| `/agents` | Tools & Monitoring | Open the subagents manager panel to monitor background tasks and logs. |
| `/artifact` | Tools & Monitoring | Open the Artifact Review panel to view plans, diffs, and task lists. |
| `/clear` | Conversation | Clears the prompt and starts a fresh conversation session. |
| `/config` (alias `/settings`) | Configuration | Opens the full-screen overlay menu for all options. |
| `/context` | Utility | View current token usage, cache status, and context window limits. |
| `/fast` | Configuration | Switch to **Fast Mode** (immediate execution without a planning phase). |
| `/feedback` | Utility | Open the link to submit user feedback to the Antigravity team. |
| `/fork` | Conversation | Branches the current conversation from an earlier point into a new workspace. |
| `/hooks` | Tools & Monitoring | List, enable/disable, or view logs for active event hooks. |
| `/keybindings` | Configuration | Open the interactive keyboard shortcut editor. |
| `/logout` | Account | Log out of your Google session and clear cached credentials. |
| `/mcp` | Tools & Monitoring | Open the panel to configure and manage Model Context Protocol servers. |
| `/model` | Configuration | Select the default reasoning model (persists across sessions). |
| `/open <path>` | Utility | Immediately open a file in your preferred external editor. |
| `/permissions` | Configuration | Select agent autonomy level (`request-review`, `always-proceed`, or `strict`). |
| `/planning` | Configuration | Switch to **Planning Mode** (thorough research and artifact generation). |
| `/rename <name>` | Conversation | Rename the active conversation thread for easier tracking. |
| `/resume` (alias `/switch`) | Conversation | Open the conversation picker to resume or switch sessions. |
| `/rewind` (alias `/undo`) | Conversation | Roll back conversation history to a previous checkpoint. |
| `/skills` | Tools & Monitoring | Browse local and global encapsulated agent workflows. |
| `/statusline` | Configuration | Customize real-ce indicators displayed in the CLI status bar. |
| `/tasks` | Tools & Monitoring | Monitor, view logs for, or terminate active background tasks. |
| `/title` | Conversation | Generate or set a succinct title and git branch name for the session. |
| `/usage` (alias `?`) | Utility | Open the inline interactive help manual inside the terminal. |

## Advanced & Specialized Commands

- **/btw**: "By The Way" mode. Forces the agent to answer using only its current context without using any tools.
- **/goal**: Executes the agent until the specified task is completely finished, without asking for intermediate user input (Autonomous Mode).
- **/grill-me**: Forces the agent to ask clarifying questions before implementation to align on the details of a plan.
- **/schedule**: Schedule an instruction for a future time or recurring Cron-based execution.
- **/teamwork-preview**: (Ultra Plan Only) Launches advanced multi-agent orchestration for extremely complex goals.

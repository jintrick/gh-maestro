---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/actions/setup/md/mcp_policy_error.md
original_title: mcp_policy_error
fetched_at: 2026-06-14T00:40:04.220860+00:00
---

> [!WARNING]
> **MCP Servers Blocked by Policy**: The Copilot CLI blocked MCP server connections due to an organization or enterprise policy. The agent ran without access to MCP tools (GitHub API, safe outputs, etc.).

This is a **policy configuration issue**, not a transient error — retrying will not help.

<details>
<summary>How to fix this</summary>

An organization or enterprise administrator must enable the **"MCP servers in Copilot"** policy:

1. Go to your **enterprise or organization settings**
2. Navigate to **Policies** → **Copilot**
3. Enable **"MCP servers in Copilot"**

For detailed instructions, see the [official documentation](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-mcp-usage/configure-mcp-server-access).

> **Note:** On some GitHub Enterprise instances, the **Policies** tab may only be visible at the **enterprise level**, not the organization level.

</details>

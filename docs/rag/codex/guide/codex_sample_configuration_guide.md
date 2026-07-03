---
source_url: https://developers.openai.com/codex/llms-full.txt
original_title: Sample Configuration
fetched_at: 2026-07-03T06:05:55.863Z
---

# Sample Configuration

Use this example configuration as a starting point. It includes most keys Codex reads from `config.toml`, along with default behaviors, recommended values where helpful, and short notes.

For explanations and guidance, see:

- [Config basics](https://developers.openai.com/codex/config-basic)
- [Advanced Config](https://developers.openai.com/codex/config-advanced)
- [Config Reference](https://developers.openai.com/codex/config-reference)
- [Sandbox and approvals](https://developers.openai.com/codex/agent-approvals-security#sandbox-and-approvals)
- [Managed configuration](https://developers.openai.com/codex/enterprise/managed-configuration)

Use the snippet below as a reference. Copy only the keys and sections you need into `~/.codex/config.toml` (or into a project-scoped `.codex/config.toml`), then adjust values for your setup.

```toml
# Codex example configuration (config.toml)
#
# This file lists the main keys Codex reads from config.toml, along with default
# behaviors, recommended examples, and concise explanations. Adjust as needed.
#

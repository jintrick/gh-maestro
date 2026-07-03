---
source_url: https://developers.openai.com/codex/llms-full.txt
original_title: Agent internet access
fetched_at: 2026-07-03T06:05:55.863Z
---

# Agent internet access

By default, Codex blocks internet access during the agent phase. Setup scripts still run with internet access so you can install dependencies. You can enable agent internet access per environment when you need it.

## Risks of agent internet access

Enabling agent internet access increases security risk, including:

- Prompt injection from untrusted web content
- Exfiltration of code or secrets
- Downloading malware or vulnerable dependencies
- Pulling in content with license restrictions

To reduce risk, allow only the domains and HTTP methods you need, and review the agent output and work log.

Prompt injection can happen when the agent retrieves and follows instructions from untrusted content (for example, a web page or dependency README). For example, you might ask Codex to fix a GitHub issue:

```text
Fix this issue: https://github.com/org/repo/issues/123
```

The issue description might contain hidden instructions:

```text

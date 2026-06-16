---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/actions/setup/md/agent_timeout.md
original_title: agent_timeout
fetched_at: 2026-06-14T00:40:03.911283+00:00
---

**Agent Timed Out**: The agent job exceeded the maximum allowed execution time ({current_minutes} minutes).

To increase the timeout, add or update the `timeout-minutes` setting in your workflow's frontmatter:

```yaml
---
timeout-minutes: {suggested_minutes}
---
```

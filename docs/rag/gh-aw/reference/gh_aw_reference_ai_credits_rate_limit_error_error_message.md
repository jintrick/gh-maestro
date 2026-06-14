---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/actions/setup/md/ai_credits_rate_limit_error.md
original_title: ai_credits_rate_limit_error
fetched_at: 2026-06-14T00:40:03.919262+00:00
---

> [!WARNING]
> **AI Credits Budget Exceeded**
>
> The workflow hit the configured `max-ai-credits` guardrail.{metrics_summary}

<details>
<summary>Increase the limit</summary>

Update `max-ai-credits` in your workflow frontmatter:

```yaml
max-ai-credits: {suggested_credits}
```

</details>

<details>
<summary>Tips for reducing AI credit usage</summary>

- Review the [cost optimization guidance](https://github.github.com/gh-aw/reference/cost-management/).
- Reduce unnecessary model or tool calls in the prompt.
- Trim large inputs or excess context that does not change the outcome.
- Split large tasks across smaller runs when possible.

</details>

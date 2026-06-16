---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/actions/setup/md/daily_cap_rollup_issue.md
original_title: daily_cap_rollup_issue
fetched_at: 2026-06-14T00:40:04.024290+00:00
---

This issue tracks agentic workflow failures that were suppressed because the per-category daily issue cap of **{cap} issues per {window_hours} hours** was reached.

When a workflow repeatedly fails with the same category, new issues are no longer created once the cap is reached. Instead, a comment is added here to record each suppressed occurrence.

### What to Do

1. Review the comments below to identify the workflow(s) failing at a high rate.
2. Investigate and fix the underlying cause to reduce the failure rate.
3. Once the failure rate returns to normal, this issue can be closed.

---

> This issue is automatically managed by GitHub Agentic Workflows. Do not close this issue manually.

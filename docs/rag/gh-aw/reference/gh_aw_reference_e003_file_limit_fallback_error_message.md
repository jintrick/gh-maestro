---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/actions/setup/md/e003_file_limit_fallback.md
original_title: e003_file_limit_fallback
fetched_at: 2026-06-14T00:40:04.061190+00:00
---

> [!WARNING]
> {error_message}

The pull request could not be created because the patch contains more files than the configured limit.

To increase the limit, add `max-patch-files` to your workflow frontmatter:

```yaml
safe-outputs:
  create-pull-request:
    max-patch-files: {suggested_limit}  # adjust as needed
```

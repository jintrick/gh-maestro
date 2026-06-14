---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/actions/setup/md/integrity_filter_remediation.md
original_title: integrity_filter_remediation
fetched_at: 2026-06-14T00:40:04.131100+00:00
---

To allow these resources, lower `min-integrity` in your GitHub frontmatter:

```yaml
tools:
  github:
    min-integrity: approved  # merged | approved | unapproved | none
```


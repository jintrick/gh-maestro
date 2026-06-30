---
source_url: https://github.com/github/gh-aw/blob/fcb214e0b4aafd7ab2ad61de1d9fa2210de48973/docs/src/content/docs/reference/lockdown-mode.md
original_title: lockdown-mode
fetched_at: 2026-06-27T20:49:46.567495+00:00
---

---
title: GitHub Lockdown Mode
description: GitHub lockdown mode has been superseded by Integrity Filtering, which provides finer-grained content filtering based on author trust and merge status.
sidebar:
  order: 660
---

> [!NOTE]
> **GitHub Lockdown Mode is now replaced by GitHub Integrity Filtering.** Use [Integrity Filtering](/gh-aw/reference/integrity/) instead. Integrity filtering provides finer-grained control over which content the agent can see, based on author trust and merge status, and works without requiring additional authentication.

## Migrating to Integrity Filtering

Replace `lockdown: true` with `min-integrity: approved`:

```yaml wrap
# Before (deprecated)
tools:
  github:
    lockdown: true

# After (recommended)
tools:
  github:
    min-integrity: approved
```

Replace `lockdown: false` with `min-integrity: none`:

```yaml wrap
# Before (deprecated)
tools:
  github:
    lockdown: false

# After (recommended)
tools:
  github:
    min-integrity: none
```

## See Also

- [Integrity Filtering](/gh-aw/reference/integrity/) — Complete reference for `min-integrity`, integrity levels, user blocking, and approval labels
- [GitHub Tools Reference](/gh-aw/reference/github-tools/) — Full `tools.github` configuration

---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-unsafe-expressions.md
original_title: test-unsafe-expressions
fetched_at: 2026-06-14T00:40:11.747969+00:00
---

# Test Unsafe Expressions File

This file should be rejected because it contains unsafe expressions.

## Unsafe Expressions

- **Token**: ${{ secrets.GITHUB_TOKEN }}

This should fail at runtime.

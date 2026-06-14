---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-args-special-chars.md
original_title: test-args-special-chars
fetched_at: 2026-06-14T00:40:10.072349+00:00
---

---
on:
  workflow_dispatch:
permissions:
  contents: read
  issues: read
engine: claude
tools:
  github:
    allowed: [get_repository]
    args: ["--flag", "value with spaces", "--option=test"]
---

# Test Args Special Character Escaping

This workflow tests that special characters in args are properly escaped.

The workflow is configured with:
- `args: ["--flag", "value with spaces", "--option=test"]`

This tests that:
1. Arguments with spaces are properly quoted
2. Multiple arguments are correctly passed
3. Different argument formats (flag-style and key=value) work correctly

Please perform the following task:

1. Get information about the current repository using the GitHub tool
2. Confirm the operation completed successfully

This verifies that the args field properly handles special characters and various argument formats through JSON escaping.

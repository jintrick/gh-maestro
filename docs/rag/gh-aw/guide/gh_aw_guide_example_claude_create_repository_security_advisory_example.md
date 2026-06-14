---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-claude-create-repository-security-advisory.md
original_title: test-claude-create-repository-security-advisory
fetched_at: 2026-06-14T00:40:10.244888+00:00
---

---
on:
  workflow_dispatch:
permissions:
  security-events: write
engine: claude
features:
  dangerous-permissions-write: true
---

# Test Claude Create Repository Security Advisory

This is a test workflow to verify that Claude can create repository security advisories.

Please create a test security advisory with:
- Title: "Test Security Advisory"
- Summary: "This is a test advisory created by Claude"
- Severity: Low
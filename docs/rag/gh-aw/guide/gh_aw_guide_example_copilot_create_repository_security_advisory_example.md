---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-copilot-create-repository-security-advisory.md
original_title: test-copilot-create-repository-security-advisory
fetched_at: 2026-06-14T00:40:10.810443+00:00
---

---
on:
  workflow_dispatch:
permissions:
  security-events: write
engine: copilot
features:
  dangerous-permissions-write: true
---

# Test Copilot Create Repository Security Advisory

This is a test workflow to verify that Copilot can create repository security advisories.

Please create a test security advisory with:
- Title: "Test Security Advisory"
- Summary: "This is a test advisory created by Copilot"
- Severity: Low
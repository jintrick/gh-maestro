---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-rate-limit-defaults.md
original_title: test-rate-limit-defaults
fetched_at: 2026-06-14T00:40:11.480199+00:00
---

---
name: Test Rate Limiting with Default Ignored Roles
engine: copilot
on:
  workflow_dispatch:
  issue_comment:
    types: [created]
user-rate-limit:
  max-runs-per-window: 5
  window: 60
---

Test workflow to demonstrate default ignored roles behavior.

By default, admin, maintain, and write users are exempt from rate limiting.
Only triage and read users will be subject to rate limiting.

Hello! This is a test workflow.

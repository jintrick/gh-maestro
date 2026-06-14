---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-secret-masking.md
original_title: test-secret-masking
fetched_at: 2026-06-14T00:40:11.522087+00:00
---

---
description: Test workflow for validating secret masking and redaction functionality
on: workflow_dispatch
permissions:
  contents: read
  issues: read
  pull-requests: read
strict: false
engine: copilot
imports:
  - shared/secret-redaction-test.md
---

# Test Secret Masking Workflow

This workflow tests the secret-masking feature by importing custom secret redaction steps.

The imported steps will search for and replace the pattern "password123" with "REDACTED" in all files under /tmp/gh-aw/.

---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-runtime-import-expressions.md
original_title: test-runtime-import-expressions
fetched_at: 2026-06-14T00:40:11.497154+00:00
---

---
description: Test runtime-import with GitHub Actions expressions
on: workflow_dispatch
engine: copilot
---

# Test Runtime Import with Expressions

This workflow tests that runtime-import can handle GitHub Actions expressions safely.

## Test 1: Import file with safe expressions

Content from imported file:
{{#runtime-import test-expressions.md}}

## Test 2: Verify expressions are rendered

The actor who triggered this workflow is: ${{ github.actor }}
The repository is: ${{ github.repository }}
The run ID is: ${{ github.run_id }}

## Instructions

Please verify that:
1. The imported file content appears above with expressions rendered
2. All safe expressions show actual values, not the raw expression syntax
3. The test passes successfully

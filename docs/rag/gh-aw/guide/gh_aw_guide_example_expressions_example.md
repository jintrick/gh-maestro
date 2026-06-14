---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-expressions.md
original_title: test-expressions
fetched_at: 2026-06-14T00:40:11.265247+00:00
---

# Test Expressions File

This file is imported at runtime and contains GitHub Actions expressions.

## Safe Expressions

- **Actor**: ${{ github.actor }}
- **Repository**: ${{ github.repository }}
- **Run ID**: ${{ github.run_id }}
- **Run Number**: ${{ github.run_number }}
- **Workflow**: ${{ github.workflow }}

## Context Information

Triggered by: ${{ github.actor }}
Repository Owner: ${{ github.repository_owner }}
Server URL: ${{ github.server_url }}

All of these expressions should be rendered with actual values at runtime.

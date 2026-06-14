---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-template-github-actions-syntax.md
original_title: test-template-github-actions-syntax
fetched_at: 2026-06-14T00:40:11.640257+00:00
---

---
on:
  workflow_dispatch:
permissions:
  contents: read
engine:
  id: claude
---

# Test Template Rendering with GitHub Actions Syntax

This workflow tests template rendering with GitHub Actions expressions in conditions.

Repository: ${{ github.repository }}

{{#if true}}
## Standard Analysis

Always perform this analysis:
- Review the repository structure
- Identify key components
- Provide actionable insights
{{/if}}

{{#if false}}
## Optional Advanced Analysis (Disabled)

This section is hidden and won't be included in the prompt.
{{/if}}

## Workflow Information

- Run ID: ${{ github.run_id }}
- Run Number: ${{ github.run_number }}

Analyze the repository and provide insights.

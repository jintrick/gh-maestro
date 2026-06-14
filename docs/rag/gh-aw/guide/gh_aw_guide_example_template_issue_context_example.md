---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-template-issue-context.md
original_title: test-template-issue-context
fetched_at: 2026-06-14T00:40:11.648234+00:00
---

---
on:
  issues:
    types: [opened]
permissions:
  contents: read
  issues: read
engine:
  id: copilot
tools:
  github:
    allowed: [issue_read, create_issue_comment]
---

# Test Template with Issue Context

Analyze issue #${{ github.event.issue.number }} in repository ${{ github.repository }}.

{{#if ${{ github.event.issue.number }}}}
## Standard Analysis

Always perform this basic analysis:
- Review the issue description
- Identify the issue type
- Suggest next steps
{{/if}}

{{#if false}}
## Optional Advanced Analysis (Disabled)

This section is hidden and won't be included in the prompt.
{{/if}}

{{#if 1}}
## Additional Context

Truthy number condition - this section is included.
Provide comprehensive analysis with context.
{{/if}}

{{#if 0}}
## Debug Mode (Disabled)

Falsy number condition - this section is excluded.
{{/if}}

Add a comment to the issue with your analysis.

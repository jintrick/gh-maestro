---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-template-pr-context.md
original_title: test-template-pr-context
fetched_at: 2026-06-14T00:40:11.657211+00:00
---

---
on:
  pull_request:
    types: [opened, synchronize]
permissions:
  contents: read
  pull-requests: read
engine:
  id: claude
tools:
  github:
    allowed: [get_pull_request]
---

# Test Template with Pull Request Context

Review PR #${{ github.event.pull_request.number }} in repository ${{ github.repository }}.

{{#if true}}
## Standard Review

Always perform these checks:
- Review changed files
- Check for breaking changes
- Verify tests pass
- Review documentation updates
{{/if}}

{{#if false}}
## Experimental Analysis (Disabled)

This experimental analysis is currently disabled.
{{/if}}

{{#if null}}
## Advanced Checks (Disabled via Null)

Null evaluates to falsy - this section is excluded.
{{/if}}

{{#if undefined}}
## Debug Mode (Disabled via Undefined)

Undefined evaluates to falsy - this section is excluded.
{{/if}}

Provide your review feedback.

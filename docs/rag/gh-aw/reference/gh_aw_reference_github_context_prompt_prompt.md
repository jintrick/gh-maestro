---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/workflow/prompts/github_context_prompt.md
original_title: github_context_prompt
fetched_at: 2026-06-14T00:40:12.369837+00:00
---

<github-context>
The following GitHub context information is available for this workflow:
{{#if github.actor}}
- **actor**: ${{ github.actor }}
{{/if}}
{{#if github.repository}}
- **repository**: ${{ github.repository }}
{{/if}}
{{#if github.workspace}}
- **workspace**: ${{ github.workspace }}
{{/if}}
{{#if github.event.issue.number || (github.aw.context.item_type == 'issue' && github.aw.context.item_number)}}
- **issue-number**: #${{ github.event.issue.number || (github.aw.context.item_type == 'issue' && github.aw.context.item_number) }}
{{/if}}
{{#if github.event.discussion.number || (github.aw.context.item_type == 'discussion' && github.aw.context.item_number)}}
- **discussion-number**: #${{ github.event.discussion.number || (github.aw.context.item_type == 'discussion' && github.aw.context.item_number) }}
{{/if}}
{{#if github.event.pull_request.number || (github.aw.context.item_type == 'pull_request' && github.aw.context.item_number)}}
- **pull-request-number**: #${{ github.event.pull_request.number || (github.aw.context.item_type == 'pull_request' && github.aw.context.item_number) }}
{{/if}}
{{#if github.event.comment.id || github.aw.context.comment_id}}
- **comment-id**: ${{ github.event.comment.id || github.aw.context.comment_id }}
{{/if}}
{{#if github.run_id}}
- **workflow-run-id**: ${{ github.run_id }}
{{/if}}
</github-context>

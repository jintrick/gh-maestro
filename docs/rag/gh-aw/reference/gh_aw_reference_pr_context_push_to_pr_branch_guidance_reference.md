---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/actions/setup/md/pr_context_push_to_pr_branch_guidance.md
original_title: pr_context_push_to_pr_branch_guidance
fetched_at: 2026-06-14T00:40:04.330571+00:00
---


<pr-comment-tool-guidance>
When triggered by a pull request comment, if you need to push code changes, prefer using `push_to_pull_request_branch` to add commits to the existing pull request branch rather than `create_pull_request` which opens a separate new pull request. Only use `create_pull_request` if the instructions explicitly ask you to create a new, separate pull request.
</pr-comment-tool-guidance>

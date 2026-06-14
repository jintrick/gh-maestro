---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/actions/setup/md/pr_checkout_failure.md
original_title: pr_checkout_failure
fetched_at: 2026-06-14T00:40:04.312619+00:00
---

## Failed to Checkout PR Branch

**Error:** {error_message}

### Possible Reasons

This failure typically occurs when:
- The pull request has been closed or merged
- The branch has been deleted
- There are insufficient permissions to access the PR

### What to Do

If the pull request is closed, you may need to:
1. Reopen the pull request, or
2. Create a new pull request with the changes

If the pull request is still open, verify that:
- The branch still exists in the repository
- You have the necessary permissions to access it

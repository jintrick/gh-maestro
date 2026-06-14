---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/actions/setup/md/app_token_minting_failed.md
original_title: app_token_minting_failed
fetched_at: 2026-06-14T00:40:03.928238+00:00
---

**GitHub App Authentication Failed**: Failed to generate a GitHub App installation access token.

This is typically caused by an incorrect GitHub App configuration. Please verify:
- The **App ID** secret/variable is set correctly
- The **private key** secret contains a valid PEM-encoded RSA private key
- The GitHub App is **installed** on the target repository or organization
- The App has the **required permissions** for your workflow's safe-outputs

For more information, see: https://github.github.com/gh-aw/reference/safe-outputs/#github-app

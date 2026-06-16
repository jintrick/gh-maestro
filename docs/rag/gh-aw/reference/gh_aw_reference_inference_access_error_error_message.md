---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/actions/setup/md/inference_access_error.md
original_title: inference_access_error
fetched_at: 2026-06-14T00:40:04.123122+00:00
---


**Inference Access Denied**: The Copilot CLI failed because the token does not have access to inference. This can happen when:

- Your organization has restricted Copilot access
- The `COPILOT_GITHUB_TOKEN` does not have a valid Copilot subscription
- Required policies have not been enabled by your administrator

To resolve this, verify that the `COPILOT_GITHUB_TOKEN` secret belongs to an account with an active Copilot subscription and check your [Copilot settings](https://github.com/settings/copilot).


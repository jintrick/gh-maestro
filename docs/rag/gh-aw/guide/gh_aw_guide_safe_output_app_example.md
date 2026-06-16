---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/workflow/testdata/wasm_golden/fixtures/shared/safe-output-app.md
original_title: safe-output-app
fetched_at: 2026-06-14T00:40:12.489516+00:00
---

---
#safe-outputs:
#  app:
#    app-id: ${{ vars.APP_ID }}
#    private-key: ${{ secrets.APP_PRIVATE_KEY }}
---

<!--
# Shared Safe Output App Configuration

This shared workflow provides repository-level GitHub App configuration for safe outputs.

## Configuration Variables

This shared workflow expects:
- **Repository Variable**: `APP_ID` - The GitHub App ID
- **Repository Secret**: `APP_PRIVATE_KEY` - The GitHub App private key

## Usage

Import this configuration in your workflows to enable GitHub App authentication for safe outputs.

The configuration will be automatically merged into your workflow's safe-outputs section.

## Benefits

- **Centralized Configuration**: Single source of truth for app credentials
- **Easy Updates**: Change credentials in one place
- **Consistent Usage**: All workflows use the same configuration pattern
- **Repository-Scoped**: Uses repository-specific variables and secrets
-->

---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/example-campaign.md
original_title: example-campaign
fetched_at: 2026-06-14T00:40:09.994558+00:00
---

---
on:
  workflow_dispatch:
permissions:
  contents: read
  actions: read
  issues: read
tracker-id: example-fingerprint-2024
safe-outputs:
  create-issue:
    title-prefix: "[Example] "
    labels: [example, automated]
features:
  dangerous-permissions-write: true
---

# Example Fingerprint Workflow

This is an example workflow that demonstrates the tracker-id feature.

When this workflow creates an issue, it will include a hidden HTML comment:

```html
<!-- gh-aw-tracker-id: example-fingerprint-2024 -->
```

This tracker-id can be used to:
- Search for all assets created by this workflow
- Track and manage related assets across the repository
- Filter issues, discussions, PRs, and comments by tracker-id

The tracker-id must be:
- At least 8 characters long
- Contain only alphanumeric characters, hyphens, and underscores
- Unique across your workflows for effective tracking

## Example Output

Create an issue with the title "Test Issue with Fingerprint" and body content explaining how the tracker-id feature works.

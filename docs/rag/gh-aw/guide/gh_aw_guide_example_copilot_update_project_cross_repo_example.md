---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-copilot-update-project-cross-repo.md
original_title: test-copilot-update-project-cross-repo
fetched_at: 2026-06-14T00:40:11.163519+00:00
---

---
description: Test update-project with target_repo for cross-repo project item resolution
on:
  workflow_dispatch:
permissions:
  contents: read
name: Test Copilot Update Project Cross Repo
engine: copilot
safe-outputs:
  update-project:
    github-token: ${{ secrets.GH_AW_WRITE_PROJECT_TOKEN }}
    project: "https://github.com/orgs/myorg/projects/42"
    target-repo: myorg/backend
    allowed-repos:
      - myorg/docs
      - myorg/frontend
---

# Test Cross-Repo Project Item Update

This workflow demonstrates updating project fields on issues that live in
repositories other than the workflow host repo (cross-repo org-level project).

Update project "https://github.com/orgs/myorg/projects/42":
- Set the Status field to "In Progress" for issue #123 in myorg/docs
- Set the Status field to "Done" for issue #456 in myorg/frontend

Use the following output format for each update:

```json
{
  "type": "update_project",
  "project": "https://github.com/orgs/myorg/projects/42",
  "content_type": "issue",
  "content_number": 123,
  "target_repo": "myorg/docs",
  "fields": { "Status": "In Progress" }
}
```

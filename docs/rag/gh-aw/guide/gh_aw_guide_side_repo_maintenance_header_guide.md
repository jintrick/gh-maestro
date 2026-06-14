---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/workflow/assets/side_repo_maintenance_header.md
original_title: side_repo_maintenance_header
fetched_at: 2026-06-14T00:40:12.265116+00:00
---

This file is the agentic maintenance workflow for the SideRepoOps target
repository "{REPO_SLUG}". It lives in the side (automation) repository and runs
maintenance operations — safe-outputs replay, label creation, activity reports,
validation, and expired-entity cleanup — against that target repository using a
dedicated cross-repo token.

You do not need to edit this file manually. It is regenerated automatically whenever
you recompile your workflows. To regenerate, run:
  gh aw compile

For more information on the SideRepoOps pattern and how this file fits into it, see:
  https://github.github.com/gh-aw/patterns/side-repo-ops/
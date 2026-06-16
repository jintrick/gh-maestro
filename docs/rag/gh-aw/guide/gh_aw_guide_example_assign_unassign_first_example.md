---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-assign-unassign-first.md
original_title: test-assign-unassign-first
fetched_at: 2026-06-14T00:40:10.120221+00:00
---

---
name: Test Assign with Unassign First
description: Test workflow for assign_to_user with unassign-first feature
on:
  workflow_dispatch:
    inputs:
      issue_number:
        description: 'Issue number to test with'
        required: true
        type: string

permissions:
  actions: write
  contents: read
  issues: read

engine: copilot
timeout-minutes: 5

safe-outputs:
  assign-to-user:
    max: 5
    unassign-first: true
features:
  dangerous-permissions-write: true
---

# Assign to User with Unassign First Test

This workflow tests the `assign_to_user` safe output feature with the `unassign-first` option enabled.

## Task

Assign the user "copilot" to issue #${{ github.event.inputs.issue_number }} using the `assign_to_user` tool from the `safeoutputs` MCP server.

The `unassign-first: true` configuration should automatically unassign any current assignees before assigning the new user.

Do not use GitHub tools. The assign_to_user tool will handle both the unassignment and assignment.

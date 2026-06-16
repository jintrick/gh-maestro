---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-assign-to-agent.md
original_title: test-assign-to-agent
fetched_at: 2026-06-14T00:40:10.100275+00:00
---

---
name: Test Assign to Agent
description: Test workflow for assign_to_agent safe output feature with auto-resolution
on:
  issues:
    types: [labeled]
  workflow_dispatch:
    inputs:
      issue_number:
        description: 'Issue number to test with'
        required: true
        type: string

permissions:
  actions: read
  contents: read
  issues: read
  pull-requests: read

# NOTE: Assigning Copilot coding agent requires:
# 1. A Personal Access Token (PAT) or GitHub App token with repo scope
#    - The standard GITHUB_TOKEN does NOT have permission to assign bot agents
#    - Create a PAT at: https://github.com/settings/tokens
#    - Add it as a repository secret named GH_AW_AGENT_TOKEN
#    - Required scopes: repo (full control) or fine-grained: actions, contents, issues, pull-requests (write)
# 
# 2. All four workflow permissions declared above (for the safe output job)
#
# 3. Repository Settings > Actions > General > Workflow permissions:
#    Must be set to "Read and write permissions"

engine: copilot
timeout-minutes: 5

safe-outputs:
  assign-to-agent:
    max: 5
    name: copilot
    target: "triggering"  # Auto-resolves from workflow context (default)
    allowed: [copilot]     # Only allow copilot agent
strict: false
---

# Assign to Agent Test Workflow

This workflow tests the `assign_to_agent` safe output feature with automatic target resolution.

## Task

**For issues event:**
Assign the Copilot coding agent to the triggering issue using the `assign_to_agent` tool from the `safeoutputs` MCP server. The issue number will be auto-resolved from the workflow context.

**For workflow_dispatch:**
Assign the Copilot coding agent to issue #${{ github.event.inputs.issue_number }} by providing the explicit issue number.

The `assign_to_agent` tool will handle the actual assignment using the configured GH_AW_AGENT_TOKEN.

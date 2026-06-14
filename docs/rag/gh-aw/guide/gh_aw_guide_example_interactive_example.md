---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-interactive.md
original_title: test-interactive
fetched_at: 2026-06-14T00:40:11.339049+00:00
---

---
on:
  workflow_dispatch:
    inputs:
      task_description:
        description: 'Description of the task to perform'
        required: true
        type: string
      priority:
        description: 'Priority level'
        required: false
        type: string
        default: 'medium'
      dry_run:
        description: 'Run in dry-run mode (no actual changes)'
        required: false
        type: string
        default: 'false'
engine: copilot
tools:
  github:
    toolsets: [default]
permissions:
  contents: read
network: defaults
---

# Test Interactive Workflow

This is a test workflow for demonstrating the interactive mode of `gh aw run`.

When triggered via workflow_dispatch, it accepts:
- **task_description**: A required string describing what to do
- **priority**: An optional priority level (default: medium)  
- **dry_run**: An optional string flag for dry-run mode (default: 'false')

The workflow will:
1. Display the provided inputs
2. Perform a simple task based on the description
3. Show completion message

This workflow is for testing purposes only.

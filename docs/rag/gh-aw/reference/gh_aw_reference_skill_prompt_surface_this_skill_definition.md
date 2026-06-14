---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/SKILL.md
original_title: SKILL
fetched_at: 2026-06-14T00:39:54.330228+00:00
---

# gh-aw Prompt Surface

This repository builds **gh-aw** (GitHub Agentic Workflows), a GitHub CLI extension for writing workflows in markdown and compiling them to GitHub Actions.

## What this surface does

- Converts markdown workflow specs (`.md`) into compiled lock files (`.lock.yml`)
- Supports multiple AI engines (`copilot`, `claude`, `codex`, `custom`)
- Integrates tools, including GitHub MCP servers and safe-output tooling
- Provides CLI commands to compile, run, inspect, and audit workflows

## Key concepts

1. **Workflow compilation**: edit workflow markdown, then recompile lock files
2. **Engine selection**: set `engine` in frontmatter to control runtime agent behavior
3. **MCP tools**: configure GitHub/MCP toolsets in frontmatter for repository operations
4. **Safe outputs**: workflow-safe issue/comment output paths and constraints

## Representative usage examples

```bash
# Compile markdown workflows to lock files
gh aw compile

# Run a workflow manually
gh aw run .github/workflows/daily-skill-optimizer.md

# Inspect MCP server usage in workflows
gh aw mcp list
gh aw mcp inspect daily-skill-optimizer

# Audit a workflow run
gh aw audit 24814681146
```

## Where to learn more in this repo

- `/AGENTS.md` for development/agent workflow conventions
- `/skills/*/SKILL.md` for focused domain guidance (GitHub MCP, docs, errors, etc.)

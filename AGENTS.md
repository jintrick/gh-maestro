# gh-maestro Agent Guide

gh-maestro is a local orchestration system that uses GitHub as durable state and coordinates multiple AI agents from Issue drafting through PR review, triage, merge, and retrospective.

## Core Principle

The project is built around Quota economics.

- Expensive models should be used for judgment: requirements, design tradeoffs, review triage, and human collaboration.
- Cheaper or faster models should do bounded execution: implementation, grep-heavy investigation, log reading, and mechanical review passes.
- Workers should not make product or merge decisions. They report facts, produce code, or emit structured findings.
- The Orchestrator plus the human owns approval, rejection, prioritization, and final merge judgment.

## Current Architecture

The main roles are:

- Orchestrator: collaborates with the human, creates Issues, starts workers, triages review comments, coordinates merge and retrospective.
- Coder: implements a specific Issue in its own git worktree.
- Explorer: gathers facts through code search and repository reading.
- Investigator: diagnoses bugs and reports root cause, impact, and fix direction.
- Review Manager: runs PR review, delegates three review aspects, emits finding JSON, and lets deterministic scripts post comments.
- Node.js review publisher: validates findings, resolves anchors, checks PR diff hunks, deduplicates, posts inline comments, and submits a final `COMMENT` review.

## Review Flow

PR review now uses the Review Manager path.

- `poll-pr.js` detects the PR for an Issue and starts `start-review-manager.js`.
- `start-review-manager.js` launches `run-review-manager.js` detached.
- `run-review-manager.js` runs Codex headlessly with the `gh-maestro-reviewer` skill.
- The Review Manager spawns three independent reviewers:
  - Correctness
  - Maintainability
  - Resilience & Security
- Reviewer guidance lives in `skills/gh-maestro-reviewer/reviewer-*.md`.
- RM output is JSON matching `scripts/review-findings-schema.json`.
- `scripts/review-publisher.js` performs validation, line-anchor resolution, diff-hunk checks, deduplication, GitHub inline comments, and final review submission.
- Final review event is always `COMMENT`. Automated review must not approve PRs.

Legacy files `scripts/run-review.js`, `scripts/start-review.js`, and `scripts/review-prompt.md` were removed. Do not reintroduce them.

## Runtime Flow

Important scripts:

- `scripts/install.js`: installs skills, shared scripts, default agent config, and hooks.
- `scripts/spawn-worker.js`: creates a worktree, links `node_modules`, writes the worker prompt, opens a WezTerm pane, and starts the selected agent.
- `scripts/agent-launch.js`: shared `promptDelivery` argv builder used by worker/RM launch paths.
- `scripts/poll-and-notify.js`: starts `poll-pr.js` for coder workers and forwards status lines to the orchestrator.
- `scripts/poll-pr.js`: detects PRs and starts the Review Manager.
- `scripts/poll-reviews.js`: monitors PR comments, review submissions, and merge state.
- `scripts/send-pane.js`: sends messages to running workers.
- `scripts/remove-worker.js`: removes worker panes and worktrees.
- `scripts/review-publisher.js`: deterministic posting pipeline for RM findings.
- `scripts/run-review-manager.js`: headless Review Manager runner.
- `scripts/start-review-manager.js`: detached Review Manager launcher with lock handling.

Worker launch is data-driven through `~/.gh-maestro/agents.json`.
The `promptDelivery` values are:

- `system-prompt-file`: Claude / Claude DeepSeek style `--append-system-prompt-file`.
- `flag`: CLI prompt flag style, currently Agy.
- `positional`: prompt as a positional argument, currently Codex.
- `send-text-after-launch`: launch first, then inject text into the pane, currently Reasonix.

If adding an agent, prefer changing `skills/agents.yaml` and install defaults over adding new per-agent branches in shared scripts.

## Skills And Installation

Canonical skill sources live under `skills/`.

Do not edit installed copies directly:

- `~/.claude/skills`
- `~/.gemini/antigravity-cli/skills`
- `.agents/skills`
- `~/.gh-maestro/skills`

After editing skills, scripts, or `skills/agents.yaml`, run:

```sh
node scripts/install.js
```

The installer:

- deploys Claude skills to `~/.claude/skills`;
- deploys Agy skills to `~/.gemini/antigravity-cli/skills`;
- deploys Codex repo skills to `.agents/skills`;
- mirrors scripts into `~/.gh-maestro/scripts`;
- deploys shared skill copies into `~/.gh-maestro/skills`;
- updates default `~/.gh-maestro/agents.json`;
- prunes stale installed scripts and skill assets.

Skill assets may include `SKILL.md` plus direct `.md` and `.json` files. Scripts belong in `scripts/`, not inside skill directories.

## Repository Conventions

- Use Node.js 18+ and the built-in `node --test` runner.
- Main test command: `npm test`.
- Prefer `rg` for searches.
- Use `apply_patch` for manual source edits.
- Avoid changing installed skill copies by hand.
- Keep generated or local state out of commits unless intentionally tracked.
- Do not use `git reset --hard` or destructive cleanup unless explicitly requested.

## Required Checks

Before committing:

- Run `npm test` for code or installer changes.
- Run `node scripts/install.js` after skill, script distribution, or `agents.yaml` changes.
- If CLI launch flags, subcommands, or argument combinations change, execute the relevant minimal command, not just `--help`.
- If staged changes include `scripts/spawn-worker.js`, `scripts/link-node-modules.js`, `scripts/install.js`, or `scripts/poll-and-notify.js` and the commit changes worker flow, audit skill/script consistency.

## Documentation Sources

Use local RAG docs before implementing or answering about tool behavior:

- Codex: `docs/rag/codex/`
- Claude Code: `docs/rag/claude-code/`
- Antigravity CLI: `docs/rag/antigravity/`
- WezTerm: `docs/rag/wezterm/`

Do not infer CLI paths, flags, config files, skill locations, or sandbox behavior from memory when local RAG docs exist.

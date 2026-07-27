# gh-maestro Agent Guide

gh-maestro is a local orchestration system that uses GitHub as durable state and coordinates multiple AI agents across planning, implementation, review, merge, and retrospective.

This file is for agent-facing operating rules and project intent. Do not use it as a script inventory or architecture dump; details that are obvious from the code should stay in the code.

## Operating Model

gh-maestro is built around quota economics.

- Use expensive models for judgment: requirements, design tradeoffs, review triage, and human collaboration.
- Use cheaper or faster workers for bounded execution: implementation, search-heavy investigation, log reading, and mechanical review passes.
- Workers do not own product decisions, merge decisions, or priority calls. They report facts, produce code, or emit structured findings.
- The orchestrator and the human own approval, rejection, prioritization, and final merge judgment.

## Agent Roles

Keep role boundaries explicit:

- Orchestrator: collaborates with the human, drafts Issues, starts workers, triages review output, and coordinates merge/retrospective.
- Coder: implements one scoped Issue in its own worktree.
- Explorer: gathers facts only.
- Investigator: diagnoses bugs and reports root cause, impact, and fix direction.
- Review Manager: coordinates independent review passes and emits structured findings; deterministic scripts handle posting.

When adding or changing roles, prefer data-driven configuration and shared launch helpers over per-agent special cases.

## Review Policy

Automated review is advisory.

- Automated review must not approve PRs.
- Keep review findings structured, reproducible, and anchored to changed code when possible.
- Do not rely on a single agent's judgment for broad review coverage; preserve independent review perspectives.
- Deterministic validation and publishing should stay outside model prompts where practical.

## Source Of Truth

Canonical sources live in the repository, not installed copies.

- Edit skill sources under `skills/`.
- Do not hand-edit installed copies under user-level skill directories or generated agent directories.
- Prefer updating `skills/agents.yaml` for default agent configuration.
- Keep scripts in `scripts/`; do not hide executable logic inside skill directories.

After changing skills, script distribution, or agent defaults, run **from the `dev` branch** (after the changes are merged):

```sh
node scripts/install.js
```

**Never run `node scripts/install.js` from a WIP/unmerged feature branch.** It writes to the machine-global `~/.gh-maestro/` shared directory and will overwrite installed state with unreviewed, unmerged code.

## Change Discipline

- Prefer existing project patterns over new abstractions.
- Keep worker launch behavior shared and data-driven.
- Avoid reintroducing removed legacy review paths unless explicitly requested.
- Keep local/generated state out of commits unless it is intentionally tracked.
- Do not use destructive git or filesystem cleanup commands unless the user explicitly asks for them.

## Checks

- Run `npm test` for code or installer changes.
- Run `node scripts/install.js` after skill, script distribution, or `skills/agents.yaml` changes **— only from the `dev` branch after changes are merged. Never from a WIP branch.**
- If CLI launch flags, subcommands, or argument combinations change, execute a minimal real command for that CLI path, not only `--help`.
- For doc-only changes, do not run `npm test` unnecessarily.

## Local Reference Docs

Use local RAG docs before implementing or answering about tool behavior:

- Codex: `docs/rag/codex/`
- Claude Code: `docs/rag/claude-code/`
- Antigravity CLI: `docs/rag/antigravity/`
- WezTerm: `docs/rag/wezterm/`

Do not infer CLI paths, flags, config files, skill locations, or sandbox behavior from memory when local RAG docs exist. If empirical behavior contradicts RAG docs, prioritize real behavior and update the docs.

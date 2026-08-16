# gh-maestro Agent Guide

gh-maestro is a local orchestration system that uses GitHub as durable state and coordinates multiple AI agents across planning, implementation, review, merge, and retrospective.

This file is for agent-facing operating rules and project intent. Do not use it as a script inventory or architecture dump; details that are obvious from the code should stay in the code.

## Getting Oriented

Treat yourself like a new team member joining the project: before diagnosing anything, orient yourself in what has actually happened recently.

- Check recent merged PRs and issue activity (`gh pr list --state merged --limit 15`, `gh issue list ...`) before asserting what state the code or config is in. Not knowing the recent issues/PRs is not an acceptable starting point for any agent working on this project — it's the baseline, not an optional deep-dive.
- If something looks broken or stale, check whether a recent PR already addressed it (or explicitly didn't) before concluding it's an unaddressed gap.

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
- Diagnostician: diagnoses bugs and reports root cause, impact, and fix direction.
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

**Before claiming the installed copy (`~/.gh-maestro/`) is stale relative to `dev`, verify it concretely — do not assume.** A quick `diff` between an installed file and `git show dev:<path>` piped through process substitution can produce a misleading wall of differences on Windows/Git Bash for reasons unrelated to actual content drift (line-ending handling, fifo/process-substitution quirks). Before concluding "install.js hasn't been run" or blaming stale code for an error:
- Compare actual resolved *behavior*, not raw file diff output — e.g., call the relevant function directly (`resolveAgentConfig(...)`) and inspect the real result.
- Cross-check file mtimes against the actual merge timestamps of the commits in question (`git show -s --format=%ci <sha>` vs the installed file's mtime), not vibes.
- If a diff looks suspiciously total (entire file "replaced" rather than a few lines changed), suspect the diff invocation itself before suspecting the file.
Getting this wrong wastes the human's time chasing a diagnosis that was never real, and undermines trust in the orchestrator's judgment on questions the human cannot easily verify themselves.

## Runtime State vs Managed Storage

`~/.gh-maestro/` (home-relative) is installer-managed: `install.js` treats it as authoritative and deletes any top-level entry it did not write itself during that run. `<workspace>/.gh-maestro/` (per-workspace: `workers.json`, `assistants.json`, cursors, etc.) is a different, install.js-untouched location and is fine to write to directly — most of the codebase already does.

The actual danger (Issue #214) is not the literal string `.gh-maestro` — dozens of call sites use it legitimately. It's a `workspace` value that, through some resolution bug, becomes equal to (or nested inside) the home directory, which silently turns `<workspace>/.gh-maestro/` into `~/.gh-maestro/` and collides with the managed root. The code that broke looked identical to every other correct call site; only the runtime value of `workspace` was wrong. This is not visible by scanning source code for patterns, so there is no static/CI check for it — grepping for `.gh-maestro` would false-positive on nearly every file that legitimately uses it.

- Always obtain `workspace` via `scripts/shared/workspace.js`'s `resolveWorkspace()` (which validates against exactly this collision and returns `null` if invalid) rather than inventing new resolution logic.
- Anything that is live process/runtime state that must never be pruned by `install.js` (PID registries, locks) belongs in `scripts/shared/storage-layout.js`'s `runtimeRoot()` / `workspaceRuntimeDir()`, not `<workspace>/.gh-maestro/` — this keeps it physically separate from the managed root even if the collision above recurs. `process-lifecycle.js`'s PID registry is the reference implementation.
- If `install.js` itself needs to own a new top-level entry under `~/.gh-maestro/`, declare it in `storage-layout.js`'s `MANAGED_TOP_LEVEL` first — `ghMaestroPath()` throws immediately if a new top-level name isn't declared there.
- Review checkpoint: don't look for the string `.gh-maestro` (too common to be meaningful); check whether the `workspace` value in play was actually obtained from `resolveWorkspace()`.

## Headless Retry Is An Anti-Pattern

**Do not introduce retry loops into headless processes.** When a headless worker (coder, Review Manager, explorer, diagnostician, or any agent launched without a visible pane) hits a failure it might resolve by trying again, it must surface that failure to the orchestrator instead of looping on its own.

A runaway loop inside a headless process is the worst failure mode this system has. Nobody sees it: the orchestrator reads the silence as "the report has not arrived yet" and keeps waiting, the human sees nothing at all, and the model burns quota the entire time. This has already happened in other forms (workers spinning at 100% CPU after their final report).

- Failures always route to the orchestrator once. The orchestrator decides whether to retry, restart, escalate to the human, or abandon.
- This applies to the model's own agentic retries as much as to `while` loops in scripts. "The model will give up eventually" is not a bound.
- Where a bound genuinely must live inside a process, it is enforced by deterministic code (a count or a deadline), never by the model's discretion.
- Bounded, non-agentic retries around a single transient I/O operation (a file rename, one HTTP request) are not what this rule is about. The rule targets loops that re-run agent work.

## Stopping Is A Human Or Orchestrator Decision, Never A Mechanism

**Never gate commit, push, or merge on an automated check.** No pre-commit/pre-push hook that runs the test suite, no CI workflow that must pass, no branch protection rule that blocks merging. The orchestrator and the human decide when work stops. Machinery reports facts; it does not hold the gate.

This is a design principle, not a preference, and it has been re-learned the hard way several times:

- **Environment drift makes a second test run a different test run.** A hook or CI runs with different environment variables than the coder's own session, so a suite that is green in the coder's worktree can fail there. A coder told to fix a failure it cannot reproduce has nothing to converge on. This has happened: a coder spent 70 minutes trying to fix a test that was never broken in its own environment.
- **Blocking push traps the coder.** A coder cannot finish its work without pushing. Gate the push and it cannot complete, cannot report, and loops — the failure mode described in "Headless Retry Is An Anti-Pattern".
- **Blocking merge traps the human.** A branch protection rule that refuses a red merge also refuses the urgent fix that would make it green.
- The pre-push test hook was introduced and then removed for exactly these reasons (plus hook environment variables leaking into tests and reaching the real repository, Issue #283). Do not reintroduce it in a new form.

The replacement pattern is **declare and inspect, never re-run and block**: whoever ran the tests reports the result together with the commit it applies to, and the orchestrator surfaces that record — present, absent, or stale — without interpreting it. Nothing re-runs the suite, so no environment drift is possible, and nothing is ever mechanically refused.

This also means the orchestrator must not launder a judgement into a fact. "That failure is unrelated to this change" is a judgement and must never gate a merge presentation.

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
- **`dev` must never be in a state where `npm test` has any failures.** A failing test blocks merge no matter how unrelated it looks to the change under review — "unrelated" is a rationalization, not a valid reason to proceed. Do not accept a coder's prose summary ("tests pass") as evidence; read the actual test-runner summary line (`# fail`) yourself before presenting anything as merge-ready. If a failing test already exists on `dev`, fixing it takes priority over other work — do not work around it or defer it.

## Local Reference Docs

Use local RAG docs before implementing or answering about tool behavior:

- Codex: `docs/rag/codex/`
- Claude Code: `docs/rag/claude-code/`
- Antigravity CLI: `docs/rag/antigravity/`
- WezTerm: `docs/rag/wezterm/`

Do not infer CLI paths, flags, config files, skill locations, or sandbox behavior from memory when local RAG docs exist. If empirical behavior contradicts RAG docs, prioritize real behavior and update the docs.

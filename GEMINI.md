# gh-maestro Gemini/Antigravity Rules

This file holds Gemini/Antigravity-specific rules that must apply every session. Refer to `AGENTS.md` for orchestrator-wide rules.

## Git Operation Rules

- **Branch Creation**: Always create new task branches from a clean remote branch (e.g. `origin/dev`), never from a local branch that may contain unmerged commits.
  - Correct: `git checkout -b feature/name origin/dev`
  - Incorrect: `git checkout -b feature/name` (when the current local branch is not in sync with remote dev)
- **Pull Requests**: When creating a Pull Request via GitHub CLI (`gh`), always explicitly specify the base branch as `dev` to avoid merging into the default branch (e.g. `main`) unless explicitly instructed otherwise.
  - Correct: `gh pr create --base dev`
- **Force Push**: Confirm the Pull Request state before force pushing (`git push -f`) to ensure we do not overwrite any critical branch states or closed PRs.

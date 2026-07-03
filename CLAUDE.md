# gh-maestro

A local orchestration system that uses GitHub as durable state and coordinates multiple AI agents.

@AGENTS.md

See `AGENTS.md` for quota economics, agent roles, review policy, and change discipline. This file holds only Claude Code specific rules that must apply every session.

## Git Operation Rules

- Once a file change is approved, commit and push it immediately in the same turn. Do not wait for a separate instruction.
- Always confirm with the user before running `git reset --hard`. Never run it unprompted.
- If a push fails as non-fast-forward, do not use `git reset --hard`. Report the situation to the user and ask how to proceed.

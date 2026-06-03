# Antigravity Goal Mode (/goal)

Goal Mode is an autonomous execution state where the agent works continuously toward a defined objective without pausing for intermediate user confirmation.

## How it Works
- Triggered via the `/goal <instruction>` command.
- The agent enters a loop of: `Planning` -> `Tool Execution` -> `Result Verification` -> `Self-Correction`.
- It only stops when:
  1. The goal is achieved.
  2. A terminal error occurs that the agent cannot fix.
  3. The user manually interrupts the session.

## Best Practices
- **Sandbox Integration**: Strongly recommended to use with `enableTerminalSandbox: true`.
- **Incremental Goals**: Provide clear, verifiable sub-tasks rather than a single vague "Fix the project" goal.
- **Monitoring**: Use `/tasks` to watch the logs as the agent operates in Goal Mode.

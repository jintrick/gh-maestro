# Antigravity Grill Me Mode (/grill-me)

Grill Me is a specialized alignment state designed to prevent "hand-off" errors by forcing the agent to challenge the user's instructions before implementation.

## Purpose
- Surface hidden assumptions.
- Identify contradictory requirements in the implementation plan.
- Ensure the agent has all necessary context (files, credentials, API keys) before starting long-running tasks.

## Usage
- Trigger via `/grill-me` before approving an Implementation Plan.
- The agent will generate a list of "Inquisitive Counter-Questions."
- Implementation is blocked until the agent is satisfied with the user's answers or the user explicitly overrides the "Grill."

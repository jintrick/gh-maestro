## Execution Modes
Antigravity supports two primary execution modes that control plan generation:
- **Planning Mode** (Active via **`/planning`**): The agent researches the codebase thoroughly and generates a detailed Implementation Plan (Artifact) before any code is modified.
- **Fast Mode** (Active via **`/fast`**): The agent skips the planning phase and executes changes directly. Recommended for simple, localized tasks.

## Review Flow
- Unless the artifact review policy is set to "Always Proceed", the agent will request a review of the plan before making changes.
- **Approve**: Click "Proceed" (in-conversation or in the artifact header) to instantly continue.
- **Feedback**: You can add comments directly on the artifact to decrease scope, correct discrepancies, or suggest a different tech stack.
- **Review Submission**: After commenting, you can click "Review" to submit all feedback. The agent will then iterate on the plan, re-request a review, or begin work based on the corrections.

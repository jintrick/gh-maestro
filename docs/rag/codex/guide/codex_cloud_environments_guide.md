---
source_url: https://developers.openai.com/codex/llms-full.txt
original_title: Cloud environments
fetched_at: 2026-07-03T06:05:55.863Z
---

# Cloud environments

Use environments to control what Codex installs and runs during cloud tasks. For example, you can add dependencies, install tools like linters and formatters, and set environment variables.

Configure environments in [Codex settings](https://chatgpt.com/codex/settings/environments).

## How Codex cloud tasks run

Here's what happens when you submit a task:

1. Codex creates a container and checks out your repo at the selected branch or commit SHA.
2. Codex runs your setup script, plus an optional maintenance script when a cached container is resumed.
3. Codex applies your internet access settings. Setup scripts run with internet access. Agent internet access is off by default, but you can enable limited or unrestricted access if needed. See [agent internet access](https://developers.openai.com/codex/cloud/internet-access).
4. The agent runs terminal commands in a loop. It edits code, runs checks, and tries to validate its work. If your repo includes `AGENTS.md`, the agent uses it to find project-specific lint and test commands.
5. When the agent finishes, it shows its answer and a diff of any files it changed. You can open a PR or ask follow-up questions.

## Default universal image

The Codex agent runs in a default container image called `universal`, which comes pre-installed with common languages, packages, and tools.

In environment settings, select **Set package versions** to pin versions of Python, Node.js, and other runtimes.

For details on what's installed, see
  [openai/codex-universal](https://github.com/openai/codex-universal) for a
  reference Dockerfile and an image that can be pulled and tested locally.

While `codex-universal` comes with languages pre-installed for speed and convenience, you can also install additional packages to the container using [setup scripts](#manual-setup).

## Environment variables and secrets

**Environment variables** are set for the full duration of the task (including setup scripts and the agent phase).

**Secrets** are similar to environment variables, except:

- They are stored with an additional layer of encryption and are only decrypted for task execution.
- They are only available to setup scripts. For security reasons, secrets are removed before the agent phase starts.

## Automatic setup

For projects using common package managers (`npm`, `yarn`, `pnpm`, `pip`, `pipenv`, and `poetry`), Codex can automatically install dependencies and tools.

## Manual setup

If your development setup is more complex, you can also provide a custom setup script. For example:

```bash

---
source_url: https://developers.openai.com/codex/llms-full.txt
original_title: Install dependencies
fetched_at: 2026-07-03T06:05:55.863Z
---

# Install dependencies

poetry install --with test
pnpm install
```

Setup scripts run in a separate Bash session from the agent, so commands like
  `export` do not persist into the agent phase. To persist environment
  variables, add them to `~/.bashrc` or configure them in environment settings.

## Container caching

Codex caches container state for up to 12 hours to speed up new tasks and follow-ups.

When an environment is cached:

- Codex clones the repository and checks out the default branch.
- Codex runs the setup script and caches the resulting container state.

When a cached container is resumed:

- Codex checks out the branch specified for the task.
- Codex runs the maintenance script (optional). This is useful when the setup script ran on an older commit and dependencies need to be updated.

Codex automatically invalidates the cache if you change the setup script, maintenance script, environment variables, or secrets. If your repo changes in a way that makes the cached state incompatible, select **Reset cache** on the environment page.

For Business and Enterprise users, caches are shared across all users who have
  access to the environment. Invalidating the cache will affect all users of the
  environment in your workspace.

## Internet access and network proxy

Internet access is available during the setup script phase to install dependencies. During the agent phase, internet access is off by default, but you can configure limited or unrestricted access. See [agent internet access](https://developers.openai.com/codex/cloud/internet-access).

Environments run behind an HTTP/HTTPS network proxy for security and abuse prevention purposes. All outbound internet traffic passes through this proxy.

---

---
source_url: https://developers.openai.com/codex/llms-full.txt
original_title: Web Search
fetched_at: 2026-07-03T06:05:55.863Z
---

# Web Search

################################################################################

# Web search mode: disabled | cached | live. Default: "cached"

# cached serves results from a web search cache (an OpenAI-maintained index).

# cached returns pre-indexed results; live fetches the most recent data.

# If you use --yolo or another full access sandbox setting, web search defaults to live.

web_search = "cached"

# Config profiles are separate files under CODEX_HOME.

# Example: ~/.codex/ci.config.toml, selected with codex --profile ci.

# Suppress the warning shown when under-development feature flags are enabled.

# suppress_unstable_features_warning = true

################################################################################

# Agents (multi-agent roles and limits)

################################################################################

[agents]

# Maximum concurrently open agent threads. Default: 6

# max_threads = 6

# Maximum nested spawn depth. Root session starts at depth 0. Default: 1

# max_depth = 1

# Default timeout per worker for spawn_agents_on_csv jobs. When unset, the tool defaults to 1800 seconds.

# job_max_runtime_seconds = 1800

# [agents.reviewer]

# description = "Find correctness, security, and test risks in code."

# config_file = "./agents/reviewer.toml" # relative to the config.toml that defines it

# nickname_candidates = ["Athena", "Ada"]

################################################################################

# Skills (per-skill overrides)

################################################################################

# Disable or re-enable a specific skill without deleting it.

[[skills.config]]

# path = "/path/to/skill/SKILL.md"

# enabled = false

################################################################################

# Sandbox settings (tables)

################################################################################

# Extra settings used only when sandbox_mode = "workspace-write".

[sandbox_workspace_write]

# Additional writable roots beyond the workspace (cwd). Default: []

writable_roots = []

# Allow outbound network access inside the sandbox. Default: false

network_access = false

# Exclude $TMPDIR from writable roots. Default: false

exclude_tmpdir_env_var = false

# Exclude /tmp from writable roots. Default: false

exclude_slash_tmp = false

################################################################################

# Shell Environment Policy for spawned processes (table)

################################################################################

[shell_environment_policy]

# inherit: all (default) | core | none

inherit = "all"

# Skip default excludes for names containing KEY/SECRET/TOKEN (case-insensitive). Default: false

ignore_default_excludes = false

# Case-insensitive glob patterns to remove (e.g., "AWS*\*", "AZURE*\*"). Default: []

exclude = []

# Explicit key/value overrides (always win). Default: {}

set = {}

# Whitelist; if non-empty, keep only matching vars. Default: []

include_only = []

# Experimental: run via user shell profile. Default: false

experimental_use_profile = false

################################################################################

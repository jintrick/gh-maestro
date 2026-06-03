---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/config/set_environment_variables.md
original_title: set_environment_variables
fetched_at: 2026-05-31T22:38:59.616894+00:00
---

---
tags:
  - spawn
---
# `set_environment_variables`

Specifies a map of environment variables that should be set when spawning new
commands in the `"local"` domain.  This configuration is consulted at the time
that a program is launched.  It is not possible to update the environment of a
running program on any Operating System.

This is not used when working with remote domains.

See also: [Launching Programs](../../launch.md#passing-environment-variables-to-the-spawned-program)

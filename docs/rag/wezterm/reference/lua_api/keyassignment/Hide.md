---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/Hide.md
original_title: Hide
fetched_at: 2026-05-31T22:39:00.116223+00:00
---

# `Hide`

Hides (or minimizes, depending on the platform) the current window.

```lua
config.keys = {
  { key = 'h', mods = 'CMD', action = wezterm.action.Hide },
}
```

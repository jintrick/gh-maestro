---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/SpawnCommandInNewTab.md
original_title: SpawnCommandInNewTab
fetched_at: 2026-05-31T22:39:00.291466+00:00
---

# `SpawnCommandInNewTab`

Spawn a new tab into the current window.
The argument is a `SpawnCommand` struct that is discussed in more
detail in the [SpawnCommand](../SpawnCommand.md) docs.

```lua
config.keys = {
  -- CMD-y starts `top` in a new tab
  {
    key = 'y',
    mods = 'CMD',
    action = wezterm.action.SpawnCommandInNewTab {
      args = { 'top' },
    },
  },
}
```



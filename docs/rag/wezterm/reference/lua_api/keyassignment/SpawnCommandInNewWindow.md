---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/SpawnCommandInNewWindow.md
original_title: SpawnCommandInNewWindow
fetched_at: 2026-05-31T22:39:00.293466+00:00
---

# `SpawnCommandInNewWindow`

Spawn a new tab into a brand new window.
The argument is a `SpawnCommand` struct that is discussed in more
detail in the [SpawnCommand](../SpawnCommand.md) docs.

```lua
config.keys = {
  -- CMD-y starts `top` in a new window
  {
    key = 'y',
    mods = 'CMD',
    action = wezterm.action.SpawnCommandInNewWindow {
      args = { 'top' },
    },
  },
}
```



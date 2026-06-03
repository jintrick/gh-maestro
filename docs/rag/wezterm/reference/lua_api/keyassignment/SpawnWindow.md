---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/SpawnWindow.md
original_title: SpawnWindow
fetched_at: 2026-05-31T22:39:00.299467+00:00
---

# `SpawnWindow`

Create a new window containing a tab from the default tab domain.

```lua
config.keys = {
  { key = 'n', mods = 'SHIFT|CTRL', action = wezterm.action.SpawnWindow },
}
```



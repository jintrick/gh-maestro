---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/MoveTabRelative.md
original_title: MoveTabRelative
fetched_at: 2026-05-31T22:39:00.138161+00:00
---

# `MoveTabRelative`

Move the current tab relative to its peers.  The argument specifies an
offset. eg: `-1` moves the tab to the left of the current tab, while `1` moves
the tab to the right.

```lua
local act = wezterm.action

config.keys = {
  { key = '{', mods = 'SHIFT|ALT', action = act.MoveTabRelative(-1) },
  { key = '}', mods = 'SHIFT|ALT', action = act.MoveTabRelative(1) },
}
```



---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/ScrollByLine.md
original_title: ScrollByLine
fetched_at: 2026-05-31T22:39:00.227468+00:00
---

# `ScrollByLine`

{{since('20210314-114017-04b7cedd')}}

Adjusts the scroll position by the number of lines specified by the argument.
Negative values scroll upwards, while positive values scroll downwards.

```lua
local act = wezterm.action

config.keys = {
  { key = 'UpArrow', mods = 'SHIFT', action = act.ScrollByLine(-1) },
  { key = 'DownArrow', mods = 'SHIFT', action = act.ScrollByLine(1) },
}
```


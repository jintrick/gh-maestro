---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/CopyMode/MoveToViewportBottom.md
original_title: MoveToViewportBottom
fetched_at: 2026-05-31T22:39:00.434834+00:00
---

# CopyMode `MoveToViewportBottom`

{{since('20220624-141144-bd1b7c5d')}}

Moves the CopyMode cursor position to the bottom of the viewport.


```lua
local wezterm = require 'wezterm'
local act = wezterm.action

return {
  key_tables = {
    copy_mode = {
      {
        key = 'L',
        mods = 'NONE',
        action = act.CopyMode 'MoveToViewportBottom',
      },
    },
  },
}
```

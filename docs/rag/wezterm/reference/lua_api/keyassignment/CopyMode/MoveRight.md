---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/CopyMode/MoveRight.md
original_title: MoveRight
fetched_at: 2026-05-31T22:39:00.394833+00:00
---

# CopyMode `MoveRight`

{{since('20220624-141144-bd1b7c5d')}}

Moves the CopyMode cursor position one cell to the right.

```lua
local wezterm = require 'wezterm'
local act = wezterm.action

return {
  key_tables = {
    copy_mode = {
      {
        key = 'RightArrow',
        mods = 'NONE',
        action = act.CopyMode 'MoveRight',
      },
    },
  },
}
```

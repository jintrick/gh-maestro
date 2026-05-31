---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/CopyMode/MoveToSelectionOtherEndHoriz.md
original_title: MoveToSelectionOtherEndHoriz
fetched_at: 2026-05-31T22:39:00.421836+00:00
---

# CopyMode `MoveToSelectionOtherEndHoriz`

{{since('20220624-141144-bd1b7c5d')}}

Moves the CopyMode cursor position to the other horizontal end of the
selection without changing the y-coordinate; if the cursor at the left end and
the starting point at the right end, then the cursor and starting point are
swapped, with the cursor now positioned at the right end.

```lua
local wezterm = require 'wezterm'
local act = wezterm.action

return {
  key_tables = {
    copy_mode = {
      {
        key = 'O',
        mods = 'NONE',
        action = act.CopyMode 'MoveToSelectionOtherEndHoriz',
      },
    },
  },
}
```



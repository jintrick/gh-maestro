---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/CopyMode/MoveToScrollbackTop.md
original_title: MoveToScrollbackTop
fetched_at: 2026-05-31T22:39:00.411834+00:00
---

# CopyMode `MoveToScrollbackTop`

{{since('20220624-141144-bd1b7c5d')}}

Moves the CopyMode cursor position to the top of the scrollback.


```lua
local wezterm = require 'wezterm'
local act = wezterm.action

return {
  key_tables = {
    copy_mode = {
      {
        key = 'g',
        mods = 'NONE',
        action = act.CopyMode 'MoveToScrollbackTop',
      },
    },
  },
}
```


---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/CopyMode/MoveUp.md
original_title: MoveUp
fetched_at: 2026-05-31T22:39:00.440835+00:00
---

# CopyMode `MoveUp`

{{since('20220624-141144-bd1b7c5d')}}

Moves the CopyMode cursor position one cell up.

```lua
local wezterm = require 'wezterm'
local act = wezterm.action

return {
  key_tables = {
    copy_mode = {
      { key = 'UpArrow', mods = 'NONE', action = act.CopyMode 'MoveUp' },
    },
  },
}
```


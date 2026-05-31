---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/CopyMode/MoveForwardWord.md
original_title: MoveForwardWord
fetched_at: 2026-05-31T22:39:00.372834+00:00
---

# CopyMode `MoveForwardWord`

{{since('20220624-141144-bd1b7c5d')}}

Moves the CopyMode cursor position one word to the right.

```lua
local wezterm = require 'wezterm'
local act = wezterm.action

return {
  key_tables = {
    copy_mode = {
      { key = 'w', mods = 'NONE', action = act.CopyMode 'MoveForwardWord' },
    },
  },
}
```


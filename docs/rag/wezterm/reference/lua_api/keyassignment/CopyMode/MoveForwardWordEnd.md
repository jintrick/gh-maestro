---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/CopyMode/MoveForwardWordEnd.md
original_title: MoveForwardWordEnd
fetched_at: 2026-05-31T22:39:00.379833+00:00
---

# CopyMode `MoveForwardWordEnd`

{{since('20230320-124340-559cb7b0')}}

Moves the CopyMode cursor position forward to the end of word.

```lua
local wezterm = require 'wezterm'
local act = wezterm.action

return {
  key_tables = {
    copy_mode = {
      {
        key = 'e',
        mods = 'NONE',
        action = act.CopyMode 'MoveForwardWordEnd',
      },
    },
  },
}
```


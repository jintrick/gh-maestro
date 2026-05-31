---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/CopyMode/Close.md
original_title: Close
fetched_at: 2026-05-31T22:39:00.355834+00:00
---

# CopyMode `Close`

{{since('20220624-141144-bd1b7c5d')}}

Close copy mode.

```lua
local wezterm = require 'wezterm'
local act = wezterm.action

return {
  key_tables = {
    copy_mode = {
      { key = 'q', mods = 'NONE', action = act.CopyMode 'Close' },
    },
  },
}
```



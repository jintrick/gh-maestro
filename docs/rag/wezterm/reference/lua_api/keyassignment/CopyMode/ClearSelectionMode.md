---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/CopyMode/ClearSelectionMode.md
original_title: ClearSelectionMode
fetched_at: 2026-05-31T22:39:00.353833+00:00
---

# CopyMode `ClearSelectionMode`

{{since('20220807-113146-c2fee766')}}

Clears the current CopyMode selection mode without leaving CopyMode.

```lua
local wezterm = require 'wezterm'
local act = wezterm.action

return {
  key_tables = {
    copy_mode = {
      {
        key = 'y',
        mods = 'NONE',
        action = act.Multiple {
          act.CopyTo 'PrimarySelection',
          act.ClearSelection,
          -- clear the selection mode, but remain in copy mode
          act.CopyMode { 'ClearSelectionMode' },
        },
      },
    },
  },
}
```

See also: [SetSelectionMode](SetSelectionMode.md).

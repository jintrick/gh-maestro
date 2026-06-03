---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/CopyMode/CycleMatchType.md
original_title: CycleMatchType
fetched_at: 2026-05-31T22:39:00.357833+00:00
---

# CopyMode `CycleMatchType`

{{since('20220624-141144-bd1b7c5d')}}

Move the CopyMode/SearchMode cycle between case-sensitive, case-insensitive
and regular expression match types.

```lua
local wezterm = require 'wezterm'
local act = wezterm.action

return {
  key_tables = {
    search_mode = {
      { key = 'r', mods = 'CTRL', action = act.CopyMode 'CycleMatchType' },
    },
  },
}
```


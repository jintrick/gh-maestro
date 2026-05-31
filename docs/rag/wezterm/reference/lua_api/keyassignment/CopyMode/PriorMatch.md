---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/CopyMode/PriorMatch.md
original_title: PriorMatch
fetched_at: 2026-05-31T22:39:00.451834+00:00
---

# CopyMode `PriorMatch`

{{since('20220624-141144-bd1b7c5d')}}

Move the CopyMode/SearchMode selection to the previous matching text, if any.

```lua
local wezterm = require 'wezterm'
local act = wezterm.action

return {
  key_tables = {
    search_mode = {
      { key = 'Enter', mods = 'NONE', action = act.CopyMode 'PriorMatch' },
    },
  },
}
```




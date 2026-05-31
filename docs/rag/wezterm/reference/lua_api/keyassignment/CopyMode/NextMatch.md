---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/CopyMode/NextMatch.md
original_title: NextMatch
fetched_at: 2026-05-31T22:39:00.441838+00:00
---

# CopyMode `NextMatch`

{{since('20220624-141144-bd1b7c5d')}}

Move the CopyMode/SearchMode selection to the next matching text, if any.

```lua
local wezterm = require 'wezterm'
local act = wezterm.action

return {
  key_tables = {
    search_mode = {
      { key = 'n', mods = 'CTRL', action = act.CopyMode 'NextMatch' },
    },
  },
}
```

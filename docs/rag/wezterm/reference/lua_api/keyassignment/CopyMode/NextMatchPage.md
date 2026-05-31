---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/CopyMode/NextMatchPage.md
original_title: NextMatchPage
fetched_at: 2026-05-31T22:39:00.449834+00:00
---

# CopyMode `NextMatchPage`

{{since('20220624-141144-bd1b7c5d')}}

Move the CopyMode/SearchMode selection to the next matching text on the next
page of the screen, if any.

```lua
local wezterm = require 'wezterm'
local act = wezterm.action

return {
  key_tables = {
    search_mode = {
      {
        key = 'PageDown',
        mods = 'CTRL',
        action = act.CopyMode 'NextMatchPage',
      },
    },
  },
}
```


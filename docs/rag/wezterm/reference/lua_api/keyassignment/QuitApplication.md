---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/QuitApplication.md
original_title: QuitApplication
fetched_at: 2026-05-31T22:39:00.195466+00:00
---

# `QuitApplication`

Terminate the WezTerm application, killing all tabs.

```lua
local wezterm = require 'wezterm'

config.keys = {
  { key = 'q', mods = 'CMD', action = wezterm.action.QuitApplication },
}
```



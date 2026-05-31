---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/ActivateTabRelative.md
original_title: ActivateTabRelative
fetched_at: 2026-05-31T22:38:59.976997+00:00
---

# `ActivateTabRelative`

Activate a tab relative to the current tab.  The argument value specifies an
offset. eg: `-1` activates the tab to the left of the current tab, while `1`
activates the tab to the right.

```lua
local wezterm = require 'wezterm'
local act = wezterm.action
local config = {}

config.keys = {
  { key = '{', mods = 'ALT', action = act.ActivateTabRelative(-1) },
  { key = '}', mods = 'ALT', action = act.ActivateTabRelative(1) },
}

return config
```

See also [ActivateTabRelativeNoWrap](ActivateTabRelativeNoWrap.md)



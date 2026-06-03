---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/QuickSelect.md
original_title: QuickSelect
fetched_at: 2026-05-31T22:39:00.182356+00:00
---

# `QuickSelect`

{{since('20210502-130208-bff6815d')}}

Activates [Quick Select Mode](../../../quickselect.md).

```lua
local wezterm = require 'wezterm'

config.keys = {
  { key = ' ', mods = 'SHIFT|CTRL', action = wezterm.action.QuickSelect },
}
```

See also [QuickSelectArgs](QuickSelectArgs.md)

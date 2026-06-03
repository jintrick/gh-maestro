---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/ToggleFullScreen.md
original_title: ToggleFullScreen
fetched_at: 2026-05-31T22:39:00.340834+00:00
---

# `ToggleFullScreen`

Toggles full screen mode for the current window.

```lua
local wezterm = require 'wezterm'

config.keys = {
  {
    key = 'n',
    mods = 'SHIFT|CTRL',
    action = wezterm.action.ToggleFullScreen,
  },
}
```

See also: [native_macos_fullscreen_mode](../config/native_macos_fullscreen_mode.md).


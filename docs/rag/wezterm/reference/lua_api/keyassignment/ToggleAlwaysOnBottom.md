---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/ToggleAlwaysOnBottom.md
original_title: ToggleAlwaysOnBottom
fetched_at: 2026-05-31T22:39:00.336834+00:00
---

# `ToggleAlwaysOnBottom`

{{since('20240127-113634-bbcac864')}}

Toggles the window to remain behind all other windows.

```lua
config.keys = {
  {
    key = ']',
    mods = 'CMD|SHIFT',
    action = wezterm.action.ToggleAlwaysOnBottom,
  },
}
```

!!! note
    This functionality is currently only implemented on macOS. 
    The assigned values for window level will have no effect on other operating systems.

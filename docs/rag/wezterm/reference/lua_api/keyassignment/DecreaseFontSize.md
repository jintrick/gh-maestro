---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/DecreaseFontSize.md
original_title: DecreaseFontSize
fetched_at: 2026-05-31T22:39:00.083223+00:00
---

# `DecreaseFontSize`

Decreases the font size of the current window by 10%

```lua
config.keys = {
  { key = '-', mods = 'CTRL', action = wezterm.action.DecreaseFontSize },
}
```

See also [adjust_window_size_when_changing_font_size](../config/adjust_window_size_when_changing_font_size.md)

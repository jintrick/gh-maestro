---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/IncreaseFontSize.md
original_title: IncreaseFontSize
fetched_at: 2026-05-31T22:39:00.120224+00:00
---

# `IncreaseFontSize`

Increases the font size of the current window by 10%

```lua
config.keys = {
  { key = '=', mods = 'CTRL', action = wezterm.action.IncreaseFontSize },
}
```

See also [adjust_window_size_when_changing_font_size](../config/adjust_window_size_when_changing_font_size.md)

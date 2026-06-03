---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/ResetFontSize.md
original_title: ResetFontSize
fetched_at: 2026-05-31T22:39:00.213466+00:00
---

# `ResetFontSize`

Reset the font size for the current window to the value in your configuration

```lua
config.keys = {
  { key = '0', mods = 'CTRL', action = wezterm.action.ResetFontSize },
}
```



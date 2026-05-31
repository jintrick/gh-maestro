---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/ResetFontAndWindowSize.md
original_title: ResetFontAndWindowSize
fetched_at: 2026-05-31T22:39:00.205466+00:00
---

# `ResetFontAndWindowSize`

{{since('20210314-114017-04b7cedd')}}

Reset both the font size and the terminal dimensions for the current window to
the values specified by your `font`, `initial_rows`, and `initial_cols` configuration.

```lua
config.keys = {
  {
    key = '0',
    mods = 'CTRL',
    action = wezterm.action.ResetFontAndWindowSize,
  },
}
```



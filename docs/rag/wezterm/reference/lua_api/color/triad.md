---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/color/triad.md
original_title: triad
fetched_at: 2026-05-31T22:38:59.068242+00:00
---

# `color:triad()`

{{since('20220807-113146-c2fee766')}}

Returns the other two colors that form a triad. The other colors
are at +/- 120 degrees in the HSL color wheel.

```lua
local a, b = wezterm.color.parse('yellow'):triad()
```



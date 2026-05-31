---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/color/square.md
original_title: square
fetched_at: 2026-05-31T22:38:59.065258+00:00
---

# `color:square()`

{{since('20220807-113146-c2fee766')}}

Returns the other three colors that form a square. The other colors
are 90 degrees apart on the HSL color wheel.

```
local a, b, c = wezterm.color.parse("yellow"):square()
```



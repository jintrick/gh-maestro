---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/color/srgb_u8.md
original_title: srgb_u8
fetched_at: 2026-05-31T22:38:59.067241+00:00
---

# `color:srgba_u8()`

{{since('20220807-113146-c2fee766')}}

Returns a tuple of the internal SRGBA colors expressed
as unsigned 8-bit integers in the range 0-255:

```
> r, g, b, a = wezterm.color.parse("purple"):srgba_u8()
> print(r, g, b, a)
07:30:20.045 INFO logging > lua: 128 0 128 255
```

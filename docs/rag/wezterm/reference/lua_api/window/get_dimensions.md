---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/window/get_dimensions.md
original_title: get_dimensions
fetched_at: 2026-05-31T22:39:01.291654+00:00
---

# `window:get_dimensions()`

{{since('20210314-114017-04b7cedd')}}

Returns a Lua table representing the dimensions for the Window.

The table has the following fields:

- `pixel_width`: the width of the window in pixels
- `pixel_height`: the height of the window in pixels
- `dpi`: The DPI of the screen the window in on
- `is_full_screen`: whether the window is in full screen mode

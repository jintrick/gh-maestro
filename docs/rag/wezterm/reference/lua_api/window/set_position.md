---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/window/set_position.md
original_title: set_position
fetched_at: 2026-05-31T22:39:01.340327+00:00
---

# `window:set_position(x, y)`

{{since('20220807-113146-c2fee766')}}

Repositions the top-left corner of the window to the specified `x`, `y` coordinates.

Note that Wayland does not allow applications to directly control their window
placement, so this method has no effect on Wayland.

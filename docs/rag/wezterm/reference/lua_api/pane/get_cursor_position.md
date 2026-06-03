---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/pane/get_cursor_position.md
original_title: get_cursor_position
fetched_at: 2026-05-31T22:39:00.636327+00:00
---

# `pane:get_cursor_position()`

{{since('20201031-154415-9614e117')}}

Returns a lua representation of the `StableCursorPosition` struct
that identifies the cursor position, visibility and shape.

It has the following fields:

 * `x` the horizontal cell index
 * `y` the vertical stable row index
 * `shape` the `CursorShape` enum value
 * `visibility` the `CursorVisibility` enum value



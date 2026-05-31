---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/config/hide_mouse_cursor_when_typing.md
original_title: hide_mouse_cursor_when_typing
fetched_at: 2026-05-31T22:38:59.439654+00:00
---

---
tags:
  - mouse_cursor
  - appearance
---
# `hide_mouse_cursor_when_typing`

{{since('20230320-124340-559cb7b0')}}

If `true`, the mouse cursor will be hidden when typing, if your mouse cursor is
hovering over the window.

The default is `true`. Set to `false` to disable this behavior.

```lua
config.hide_mouse_cursor_when_typing = true
```

---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/OpenLinkAtMouseCursor.md
original_title: OpenLinkAtMouseCursor
fetched_at: 2026-05-31T22:39:00.150355+00:00
---

# `OpenLinkAtMouseCursor`

If the current mouse cursor position is over a cell that contains
a hyperlink, this action causes that link to be opened.

```lua
config.mouse_bindings = {
  -- Ctrl-click will open the link under the mouse cursor
  {
    event = { Up = { streak = 1, button = 'Left' } },
    mods = 'CTRL',
    action = wezterm.action.OpenLinkAtMouseCursor,
  },
}
```

---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/TogglePaneZoomState.md
original_title: TogglePaneZoomState
fetched_at: 2026-05-31T22:39:00.342834+00:00
---

# `TogglePaneZoomState`

{{since('20201031-154415-9614e117')}}

Toggles the zoom state of the current pane.  A Zoomed pane takes up
all available space in the tab, hiding all other panes while it is zoomed.
Switching its zoom state off will restore the prior split arrangement.

```lua
config.keys = {
  {
    key = 'Z',
    mods = 'CTRL',
    action = wezterm.action.TogglePaneZoomState,
  },
}
```

See also: [`unzoom_on_switch_pane`](../config/unzoom_on_switch_pane.md), [SetPaneZoomState](SetPaneZoomState.md).

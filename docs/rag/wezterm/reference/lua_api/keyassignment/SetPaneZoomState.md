---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/SetPaneZoomState.md
original_title: SetPaneZoomState
fetched_at: 2026-05-31T22:39:00.262467+00:00
---

# `SetPaneZoomState(bool)`

{{since('20220807-113146-c2fee766')}}

Sets the zoom state of the current pane.  A Zoomed pane takes up
all available space in the tab, hiding all other panes while it is zoomed.
Switching its zoom state off will restore the prior split arrangement.

Setting the zoom state to true zooms the pane if it wasn't already zoomed.
Setting the zoom state to false un-zooms the pane if it was zoomed.

See also: [`unzoom_on_switch_pane`](../config/unzoom_on_switch_pane.md),
[TogglePaneZoomState](TogglePaneZoomState.md),
[MuxTab:set_zoomed()](../MuxTab/set_zoomed.md).

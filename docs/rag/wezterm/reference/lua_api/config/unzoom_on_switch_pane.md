---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/config/unzoom_on_switch_pane.md
original_title: unzoom_on_switch_pane
fetched_at: 2026-05-31T22:38:59.806515+00:00
---

# `unzoom_on_switch_pane = true`

{{since('20211204-082213-a66c61ee9')}}

If set to `false`, the 
[`ActivatePaneDirection`](../keyassignment/ActivatePaneDirection.md) command
will have no effect if the active pane is zoomed. 

If `true`, the active pane will be unzoomed first and then switched.

See also: [`TogglePaneZoomState`](../keyassignment/TogglePaneZoomState.md)

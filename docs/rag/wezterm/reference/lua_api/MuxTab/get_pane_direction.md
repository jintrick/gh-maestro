---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/MuxTab/get_pane_direction.md
original_title: get_pane_direction
fetched_at: 2026-05-31T22:39:00.577226+00:00
---

# `tab:get_pane_direction(direction)`

{{since('20230320-124340-559cb7b0')}}

Returns pane adjacent to the active pane in *tab* in the direction *direction*.

Valid values for *direction* are:

* `"Left"`
* `"Right"`
* `"Up"`
* `"Down"`
* `"Prev"`
* `"Next"`

See [ActivatePaneDirection](../keyassignment/ActivatePaneDirection.md) for more information
about how panes are selected given direction.


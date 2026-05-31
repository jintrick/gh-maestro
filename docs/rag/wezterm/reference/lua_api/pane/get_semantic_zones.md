---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/pane/get_semantic_zones.md
original_title: get_semantic_zones
fetched_at: 2026-05-31T22:39:00.674828+00:00
---

# `pane:get_semantic_zones([zone_type])`

{{since('20230320-124340-559cb7b0')}}

When *zone_type* is omitted, returns the list of all semantic zones defined in the pane.

When *zone_type* is supplied, returns the list of all semantic zones of the matching type.

Value values for *zone_type* are:

* `"Prompt"`
* `"Input"`
* `"Output"`

See [Shell Integration](../../../shell-integration.md) for more information
about semantic zones.


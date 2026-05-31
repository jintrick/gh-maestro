---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/pane/get_text_from_semantic_zone.md
original_title: get_text_from_semantic_zone
fetched_at: 2026-05-31T22:39:00.686829+00:00
---

# `pane:get_text_from_semantic_zone(zone)`

{{since('20230320-124340-559cb7b0')}}

This is a convenience method that calls [pane:get_text_from_region()](get_text_from_region.md) on the supplied *zone* parameter.

Use [pane:get_semantic_zone_at()](get_semantic_zone_at.md) or
[pane:get_semantic_zones()](get_semantic_zones.md) to obtain a *zone*.

See [Shell Integration](../../../shell-integration.md) for more information
about semantic zones.


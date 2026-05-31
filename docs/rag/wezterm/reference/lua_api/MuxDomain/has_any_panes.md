---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/MuxDomain/has_any_panes.md
original_title: has_any_panes
fetched_at: 2026-05-31T22:39:00.555225+00:00
---

# `domain:has_any_panes()`

{{since('20230320-124340-559cb7b0')}}

Returns `true` if the mux has any panes that belong to this domain.

This can be useful when deciding whether to spawn additional panes after
attaching to a domain.


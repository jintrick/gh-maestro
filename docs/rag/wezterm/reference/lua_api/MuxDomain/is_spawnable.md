---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/MuxDomain/is_spawnable.md
original_title: is_spawnable
fetched_at: 2026-05-31T22:39:00.561225+00:00
---

# `domain:is_spawnable()`

{{since('20230320-124340-559cb7b0')}}

Returns `false` if this domain will never be able to spawn a new pane/tab/window, `true` otherwise.

Serial ports are represented by a serial domain that is not spawnable.



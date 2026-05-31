---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/pane/pane_id.md
original_title: pane_id
fetched_at: 2026-05-31T22:39:00.737859+00:00
---

# `pane:pane_id()`

{{since('20201031-154415-9614e117')}}

Returns the id number for the pane.  The Id is used to identify the pane
within the internal multiplexer and can be used when making API calls
via `wezterm cli` to indicate the subject of manipulation.


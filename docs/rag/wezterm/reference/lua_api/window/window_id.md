---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/window/window_id.md
original_title: window_id
fetched_at: 2026-05-31T22:39:01.353327+00:00
---

# `window:window_id()`

{{since('20201031-154415-9614e117')}}

Returns the id number for the window.  The Id is used to identify the window
within the internal multiplexer and can be used when making API calls
via `wezterm cli` to indicate the subject of manipulation.


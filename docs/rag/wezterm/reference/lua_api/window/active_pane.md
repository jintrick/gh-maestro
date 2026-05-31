---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/window/active_pane.md
original_title: active_pane
fetched_at: 2026-05-31T22:39:01.257298+00:00
---

# `window:active_pane()`

{{since('20221119-145034-49b9839f')}}

A convenience accessor for returning the active pane in the active tab of the
GUI window.

This is similar to [mux_window:active_pane()](../mux-window/active_pane.md)
but, because it operates at the GUI layer, it can return *Pane* objects for
special overlay panes that are not visible to the mux layer of the API.


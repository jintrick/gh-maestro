---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/mux-window/gui_window.md
original_title: gui_window
fetched_at: 2026-05-31T22:39:00.513638+00:00
---

# `window:gui_window()`

{{since('20220807-113146-c2fee766')}}

Attempts to resolve this mux window to its corresponding [Gui Window](../window/index.md).

This may not succeed for a couple of reasons:

* If called by the multiplexer daemon, there is no gui, so this will never succeed
* If the mux window is part of a workspace that is not the active workspace

This method is the inverse of [window:mux_window](../window/mux_window.md).

---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/wezterm.mux/get_window.md
original_title: get_window
fetched_at: 2026-05-31T22:39:01.131322+00:00
---

# `wezterm.mux.get_window(WINDOW_ID)`

{{since('20220624-141144-bd1b7c5d')}}

Given a window ID, verifies that the ID is a valid window known to the mux
and returns a [MuxWindow](../mux-window/index.md) object that can be used to
operate on the window.

This is useful for situations where you have obtained a window id from
some other source and want to use the various `MuxWindow` methods with it.

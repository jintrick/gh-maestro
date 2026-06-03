---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/window/perform_action.md
original_title: perform_action
fetched_at: 2026-05-31T22:39:01.320328+00:00
---

# `window:perform_action(key_assignment, pane)`

{{since('20201031-154415-9614e117')}}

Performs a key assignment against the `window` and `pane`.
There are a number of actions that can be performed against a `pane` in
a `window` when configured via the `keys` and `mouse` configuration options.

This method allows your lua script to trigger those actions for itself.

The first parameter is a key assignment such as that returned by [`wezterm.action`](../wezterm/action.md).

The second parameter is a `pane` object passed to your event callback.

For an example of this method in action, see [`wezterm.on` Custom Events](../wezterm/on.md#custom-events).

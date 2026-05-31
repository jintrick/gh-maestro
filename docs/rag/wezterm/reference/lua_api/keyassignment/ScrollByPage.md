---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/ScrollByPage.md
original_title: ScrollByPage
fetched_at: 2026-05-31T22:39:00.235466+00:00
---

# `ScrollByPage`

Adjusts the scroll position by the number of pages specified by the argument.
Negative values scroll upwards, while positive values scroll downwards.

```lua
local act = wezterm.action

config.keys = {
  { key = 'PageUp', mods = 'SHIFT', action = act.ScrollByPage(-1) },
  { key = 'PageDown', mods = 'SHIFT', action = act.ScrollByPage(1) },
}
```

{{since('20220319-142410-0fcdea07')}}

You may now use floating point values to scroll by partial pages.  This example shows
how to make the `PageUp`/`PageDown` scroll by half a page at a time:

```lua
local act = wezterm.action

config.keys = {
  { key = 'PageUp', mods = 'SHIFT', action = act.ScrollByPage(-0.5) },
  { key = 'PageDown', mods = 'SHIFT', action = act.ScrollByPage(0.5) },
}
```

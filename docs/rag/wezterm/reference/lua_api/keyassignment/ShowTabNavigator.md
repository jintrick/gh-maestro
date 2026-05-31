---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/ShowTabNavigator.md
original_title: ShowTabNavigator
fetched_at: 2026-05-31T22:39:00.289466+00:00
---

# `ShowTabNavigator`

Activate the tab navigator UI in the current tab.  The tab
navigator displays a list of tabs and allows you to select
and activate a tab from that list.

```lua
config.keys = {
  { key = 'F9', mods = 'ALT', action = wezterm.action.ShowTabNavigator },
}
```

{{since('nightly')}}

The choice corresponding to the current tab is initially selected.


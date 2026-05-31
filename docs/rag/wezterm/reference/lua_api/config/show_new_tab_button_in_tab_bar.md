---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/config/show_new_tab_button_in_tab_bar.md
original_title: show_new_tab_button_in_tab_bar
fetched_at: 2026-05-31T22:38:59.632894+00:00
---

---
tags:
  - tab_bar
---
# `show_new_tab_button_in_tab_bar = true`

{{since('20221119-145034-49b9839f')}}

When set to `true` (the default), the tab bar will display the new-tab button,
which can be left-clicked to create a new tab, or right-clicked to display the
[Launcher Menu](../../launch.md).

When set to `false`, the new-tab button will not be drawn into the tab bar.

This example turns off the tabs and new-tab button, leaving just the left and
right status areas:

```lua
wezterm.on('update-right-status', function(window, pane)
  window:set_left_status 'left'
  window:set_right_status 'right'
end)

config.use_fancy_tab_bar = false
config.show_tabs_in_tab_bar = false
config.show_new_tab_button_in_tab_bar = false
```


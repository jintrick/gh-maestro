---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/window/active_tab.md
original_title: active_tab
fetched_at: 2026-05-31T22:39:01.258297+00:00
---

# `window:active_tab()`

{{since('20230408-112425-69ae8472')}}

A convenience accessor for returning the active tab within the window.

In earlier versions of wezterm, you could obtain this via:

```lua
function active_tab_for_gui_window(gui_window)
  for _, item in ipairs(gui_window:mux_window():tabs_with_info()) do
    if item.is_active then
      return item.tab
    end
  end
end
```


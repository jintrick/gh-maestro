---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/mux-window/active_pane.md
original_title: active_pane
fetched_at: 2026-05-31T22:39:00.485053+00:00
---

# `window:active_pane()`

{{since('20230408-112425-69ae8472')}}

A convenience accessor for returning the active pane in the active tab of the window.

In earlier versions of wezterm, you could obtain this via:

```lua
function active_tab(window)
  for _, item in ipairs(window:tabs_with_info()) do
    if item.is_active then
      return item.tab
    end
  end
end

function active_pane(tab)
  for _, item in ipairs(tab:panes_with_info()) do
    if item.is_active then
      return item.pane
    end
  end
end
```

See also [gui_window:active_pane()](../window/active_pane.md), which is similar
to this method, but which can return overlay panes that are not visible to
the mux layer of the API.


---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/MuxTab/active_pane.md
original_title: active_pane
fetched_at: 2026-05-31T22:39:00.575225+00:00
---

# `tab:active_pane()`

{{since('20230408-112425-69ae8472')}}

A convenience accessor for returning the active pane in the tab.

In earlier versions of wezterm, you could obtain this via:

```lua
function active_pane(tab)
  for _, item in ipairs(tab:panes_with_info()) do
    if item.is_active then
      return item.pane
    end
  end
end
```


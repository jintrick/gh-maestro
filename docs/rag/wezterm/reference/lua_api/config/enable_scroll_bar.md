---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/config/enable_scroll_bar.md
original_title: enable_scroll_bar
fetched_at: 2026-05-31T22:38:59.322335+00:00
---

---
tags:
  - appearance
  - scroll_bar
---
# `enable_scroll_bar`

Enable the scrollbar.  This is currently disabled by default.
It will occupy the right window padding space.

If right padding is set to 0 then it will be increased to a single cell width.

```lua
config.enable_scroll_bar = true
```



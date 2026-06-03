---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/mux-window/tabs_with_info.md
original_title: tabs_with_info
fetched_at: 2026-05-31T22:39:00.536225+00:00
---

## window:tabs_with_info()

{{since('20220807-113146-c2fee766')}}

Returns an array table holding an extended info entry for each of the tabs
contained within this window.

Each element is a lua table with the following fields:

* `index` - the 0-based tab index
* `is_active` - a boolean indicating whether this is the active tab within the window
* `tab` - the [MuxTab](../MuxTab/index.md) object


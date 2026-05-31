---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/mux-window/set_title.md
original_title: set_title
fetched_at: 2026-05-31T22:39:00.522746+00:00
---

## window:set_title(TITLE)

{{since('20220807-113146-c2fee766')}}

Sets the window title to the provided string. Note that applications may
subsequently change the title via escape sequences.

```lua
window:set_title 'my title'
```



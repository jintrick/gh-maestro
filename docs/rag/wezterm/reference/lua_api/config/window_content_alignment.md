---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/config/window_content_alignment.md
original_title: window_content_alignment
fetched_at: 2026-05-31T22:38:59.905637+00:00
---

---
tags:
  - appearance
---
# `window_content_alignment`

{{since('nightly')}}

Controls the alignment of the terminal cells inside the window.

When window size is not a multiple of terminal cell size, terminal cells will be slightly smaller than the window, and leave a small gap between the two.
You can use this option to control where the additional gap will be.

The lua table has two fields and following possible values:

* `horizontal`
    * `"Left"` (the default)
    * `"Center"`
    * `"Right"`
* `vertical`
    * `"Top"` (the default)
    * `"Center"`
    * `"Bottom"`

For example, to center the terminal cells:

```lua
config.window_content_alignment = {
  horizontal = 'Center',
  vertical = 'Center',
}
```

---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/config/strikethrough_position.md
original_title: strikethrough_position
fetched_at: 2026-05-31T22:38:59.681813+00:00
---

---
tags:
  - font
---
# `strikethrough_position`

{{since('20221119-145034-49b9839f')}}

If specified, overrides the position of strikethrough lines.

The default is derived from the underline position metric specified by the designer
of the primary font.

This config option accepts different units that have slightly different interpretations:

* `2`, `2.0` or `"2px"` all specify a position of 2 pixels
* `"2pt"` specifies a position of 2 points, which scales according to the DPI of the window
* `"200%"` takes the font-specified `underline_position` and multiplies it by 2
* `"0.5cell"` takes the cell height, scales it by `0.5` and uses that as the position


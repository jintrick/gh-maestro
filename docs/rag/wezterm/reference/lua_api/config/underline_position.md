---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/config/underline_position.md
original_title: underline_position
fetched_at: 2026-05-31T22:38:59.793337+00:00
---

---
tags:
  - font
---
# `underline_position`

{{since('20221119-145034-49b9839f')}}

If specified, overrides the position of underlines.

The default is to use the underline position metric specified by the designer
of the primary font.

This config option accepts different units that have slightly different interpretations:

* `2`, `2.0` or `"2px"` all specify a position of 2 pixels
* `"2pt"` specifies a position of 2 points, which scales according to the DPI of the window
* `"200%"` takes the font-specified `underline_position` and multiplies it by 2
* `"0.1cell"` takes the cell height, scales it by `0.1` and uses that as the position

Note that the `underline_position` is often a small negative number like `-2`
or `-4` and specifies an offset from the baseline of the font.


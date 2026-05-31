---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/config/display_pixel_geometry.md
original_title: display_pixel_geometry
fetched_at: 2026-05-31T22:38:59.303907+00:00
---

---
tags:
  - font
  - appearance
---
# `display_pixel_geometry = "RGB"`

{{since('20230408-112425-69ae8472')}}

Configures whether subpixel anti-aliasing should produce either `"RGB"` or
`"BGR"` ordered output.

If your display has a `BGR` pixel geometry then you will want to set
this to `"BGR"` for the best results when using subpixel antialiasing.

The default value is `"RGB"`.


---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/config/allow_square_glyphs_to_overflow_width.md
original_title: allow_square_glyphs_to_overflow_width
fetched_at: 2026-05-31T22:38:59.084816+00:00
---

---
tags:
  - font
---

# `allow_square_glyphs_to_overflow_width = "Never"`

{{since('20210203-095643-70a364eb')}}

Configures how square symbol glyph's cell is rendered:

* "WhenFollowedBySpace" - (this is the default) deliberately overflow the cell
  width when the next cell is a space.
* "Always" - overflow the cell regardless of the next cell
  being a space.
* "Never" - strictly respect the cell width.

{{since('20210404-112810-b63a949d')}}

This setting now applies to any glyph with an aspect ratio
larger than 0.9, which covers more symbol glyphs than in
earlier releases.

The default value for this setting was changed from `Never` to
`WhenFollowedBySpace`.

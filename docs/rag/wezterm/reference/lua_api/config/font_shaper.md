---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/config/font_shaper.md
original_title: font_shaper
fetched_at: 2026-05-31T22:38:59.380060+00:00
---

---
tags:
  - font
---
# `font_shaper`

specifies the method by which text is mapped to glyphs in the available fonts.
The shaper is responsible for handling kerning, ligatures and emoji
composition.  The default is `Harfbuzz` and we have very preliminary support
for `Allsorts`.

It is strongly recommended that you use the default `Harfbuzz` shaper.

{{since('20211204-082213-a66c61ee9')}}

The incomplete `Allsorts` shaper was removed.

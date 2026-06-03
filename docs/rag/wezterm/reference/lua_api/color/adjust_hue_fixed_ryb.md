---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/color/adjust_hue_fixed_ryb.md
original_title: adjust_hue_fixed_ryb
fetched_at: 2026-05-31T22:38:59.002046+00:00
---

# `color:adjust_hue_fixed_ryb(degrees)`

{{since('20220807-113146-c2fee766')}}

Adjust the hue angle by the specified number of degrees.

This method uses the [RYB color
model](https://en.wikipedia.org/wiki/RYB_color_model), which more
closely matches how artists think of mixing colors and which is
sometimes referred to as the "artist's color wheel".

180 degrees gives the complementary color.
Three colors separated by 120 degrees form the triad.
Four colors separated by 90 degrees form the square.

See also [color:adjust_hue_fixed()](adjust_hue_fixed.md).

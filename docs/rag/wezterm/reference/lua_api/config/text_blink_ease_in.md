---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/config/text_blink_ease_in.md
original_title: text_blink_ease_in
fetched_at: 2026-05-31T22:38:59.713120+00:00
---

---
tags:
  - appearance
---
# `text_blink_ease_in = "Linear"`

{{since('20220319-142410-0fcdea07')}}

Specifies the *easing function* to use when computing the color
for text that has the blinking attribute in the fading-in
phase--when the text is fading from the background color to the
foreground color.

See [visual_bell](visual_bell.md) for more information about
easing functions.

See [cursor_blink_rate](cursor_blink_rate.md) to control the rate
at which the cursor blinks.


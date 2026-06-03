---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/config/animation_fps.md
original_title: animation_fps
fetched_at: 2026-05-31T22:38:59.105444+00:00
---

---
tags:
  - tuning
---
# `animation_fps = 10`

{{since('20220319-142410-0fcdea07')}}

This setting controls the maximum frame rate used when rendering easing effects
for blinking cursors, blinking text and visual bell.

Setting it larger will result in smoother easing effects but will increase GPU
utilization.

If you are running with a CPU renderer (eg: you have [front_end](front_end.md)
= `"Software"`, or your system doesn't have a GPU), then setting `animation_fps
= 1` is recommended, as doing so will disable easing effects and use
transitions:

```lua
config.animation_fps = 1
config.cursor_blink_ease_in = 'Constant'
config.cursor_blink_ease_out = 'Constant'
```


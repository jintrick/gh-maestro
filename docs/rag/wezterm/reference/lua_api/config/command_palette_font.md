---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/config/command_palette_font.md
original_title: command_palette_font
fetched_at: 2026-05-31T22:38:59.207563+00:00
---

---
tags:
  - font
  - command_palette
---
# `command_palette_font`

{{since('nightly')}}

Configures the font to use for command palette. The `command_palette_font`
setting can specify a set of fallbacks and other options, and is described
in more detail in the [Fonts](../../fonts.md) section.

If not specified, the font is same as the font in `window_frame.font`

You will typically use [wezterm.font](../wezterm/font.md) or
[wezterm.font_with_fallback](../wezterm/font_with_fallback.md) to specify the
font.

To specify `command_palette_font`:

```lua
config.command_palette_font = wezterm.font 'Roboto'
```

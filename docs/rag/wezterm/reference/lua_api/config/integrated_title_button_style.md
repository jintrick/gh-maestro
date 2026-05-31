---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/config/integrated_title_button_style.md
original_title: integrated_title_button_style
fetched_at: 2026-05-31T22:38:59.487465+00:00
---

---
tags:
  - appearance
---
# `integrated_title_button_style = STYLE`

{{since('20230408-112425-69ae8472')}}

Configures the visual style of the tabbar-integrated titlebar button
replacements that are shown when `window_decorations =
"INTEGRATED_BUTTONS|RESIZE"`.

Possible styles are:

* `"Windows"` - draw Windows-style buttons
* `"Gnome"` - draw Adwaita-style buttons
* `"MacOsNative"` - on macOS only, move the native macOS buttons into the tab bar.

The default value is `"MacOsNative"` on macOS systems, but `"Windows"` on other
systems.

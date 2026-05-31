---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/config/font_locator.md
original_title: font_locator
fetched_at: 2026-05-31T22:38:59.369062+00:00
---

---
tags:
  - font
---
# `font_locator`

specifies the method by which system fonts are located and loaded.  You may
specify `ConfigDirsOnly` to disable loading system fonts and use only the fonts
found in the directories that you specify in your [font_dirs](font_dirs.md)
configuration option.

Otherwise, it is recommended to omit this setting.

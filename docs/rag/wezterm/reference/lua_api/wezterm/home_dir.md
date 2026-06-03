---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/wezterm/home_dir.md
original_title: home_dir
fetched_at: 2026-05-31T22:39:00.884638+00:00
---

---
title: wezterm.home_dir
tags:
 - utility
 - filesystem
---

# `wezterm.home_dir`

This constant is set to the home directory of the user running `wezterm`.

```lua
local wezterm = require 'wezterm'
wezterm.log_error('Home ' .. wezterm.home_dir)
```



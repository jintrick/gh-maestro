---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/wezterm/config_dir.md
original_title: config_dir
fetched_at: 2026-05-31T22:39:00.800639+00:00
---

---
title: wezterm.config_dir
tags:
 - filesystem
---

# `wezterm.config_dir`

This constant is set to the path to the directory in which your `wezterm.lua`
configuration file was found.

```lua
local wezterm = require 'wezterm'
wezterm.log_error('Config Dir ' .. wezterm.config_dir)
```



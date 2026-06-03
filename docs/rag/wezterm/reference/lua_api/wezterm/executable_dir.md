---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/wezterm/executable_dir.md
original_title: executable_dir
fetched_at: 2026-05-31T22:39:00.841919+00:00
---

---
title: wezterm.executable_dir
tags:
 - filesystem
 - utility
---

# `wezterm.executable_dir`

This constant is set to the directory containing the `wezterm`
executable file.

```lua
local wezterm = require 'wezterm'
wezterm.log_error('Exe dir ' .. wezterm.executable_dir)
```



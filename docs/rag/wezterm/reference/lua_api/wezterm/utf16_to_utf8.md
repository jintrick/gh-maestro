---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/wezterm/utf16_to_utf8.md
original_title: utf16_to_utf8
fetched_at: 2026-05-31T22:39:01.024325+00:00
---

---
title: wezterm.utf16_to_utf8
tags:
 - utility
 - string
---
# `wezterm.utf16_to_utf8(str)`

{{since('20200503-171512-b13ef15f')}}

This function is overly specific and exists primarily to workaround
[this wsl.exe issue](https://github.com/microsoft/WSL/issues/4456).

It takes as input a string and attempts to convert it from utf16 to utf8.

```lua
local wezterm = require 'wezterm'

local success, wsl_list, wsl_err =
  wezterm.run_child_process { 'wsl.exe', '-l' }
wsl_list = wezterm.utf16_to_utf8(wsl_list)
```


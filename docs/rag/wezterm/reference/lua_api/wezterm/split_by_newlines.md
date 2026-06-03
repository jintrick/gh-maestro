---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/wezterm/split_by_newlines.md
original_title: split_by_newlines
fetched_at: 2026-05-31T22:39:00.992324+00:00
---

---
title: wezterm.split_by_newlines
tags:
 - utility
 - string
---
# `wezterm.split_by_newlines(str)`

{{since('20200503-171512-b13ef15f')}}

This function takes the input string and splits it by newlines (both `\n` and `\r\n`
are recognized as newlines) and returns the result as an array of strings that
have the newlines removed.

```lua
local wezterm = require 'wezterm'

local example = 'hello\nthere\n'

for _, line in ipairs(wezterm.split_by_newlines(example)) do
  wezterm.log_error(line)
end
```



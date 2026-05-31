---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/wezterm/read_dir.md
original_title: read_dir
fetched_at: 2026-05-31T22:39:00.956638+00:00
---

---
title: wezterm.read_dir
tags:
 - utility
 - filesystem
---
# `wezterm.read_dir(path)`

{{since('20200503-171512-b13ef15f')}}

This function returns an array containing the absolute file names of the
directory specified.  Due to limitations in the lua bindings, all of the paths
must be able to be represented as UTF-8 or this function will generate an
error.

```lua
local wezterm = require 'wezterm'

-- logs the names of all of the entries under `/etc`
for _, v in ipairs(wezterm.read_dir '/etc') do
  wezterm.log_error('entry: ' .. v)
end
```



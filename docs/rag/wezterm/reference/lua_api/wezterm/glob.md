---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/wezterm/glob.md
original_title: glob
fetched_at: 2026-05-31T22:39:00.872638+00:00
---

---
title: wezterm.glob
tags:
 - utility
 - filesystem
---

# `wezterm.glob(pattern [, relative_to])`

{{since('20200503-171512-b13ef15f')}}

This function evaluates the glob `pattern` and returns an array containing the
absolute file names of the matching results.  Due to limitations in the lua
bindings, all of the paths must be able to be represented as UTF-8 or this
function will generate an error.

The optional `relative_to` parameter can be used to make the results relative
to a path.  If the results have the same prefix as `relative_to` then it will
be removed from the returned path.

```lua
local wezterm = require 'wezterm'

-- logs the names of all of the conf files under `/etc`
for _, v in ipairs(wezterm.glob '/etc/*.conf') do
  wezterm.log_error('entry: ' .. v)
end
```



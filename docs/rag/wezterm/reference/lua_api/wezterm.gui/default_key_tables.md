---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/wezterm.gui/default_key_tables.md
original_title: default_key_tables
fetched_at: 2026-05-31T22:39:01.086324+00:00
---

# `wezterm.gui.default_key_tables()`

{{since('20221119-145034-49b9839f')}}

Returns a table holding the effective default set of `key_tables`.  That is the
set of keys that is used as a base if there was no configuration file.

This is useful in cases where you want to override a key table assignment
without replacing the entire set of key tables.

This example shows how to add a key assignment for `Backspace` to `copy_mode`,
without having to manually specify the entire key table:

```lua
local wezterm = require 'wezterm'
local act = wezterm.action

local copy_mode = nil
if wezterm.gui then
  copy_mode = wezterm.gui.default_key_tables().copy_mode
  table.insert(
    copy_mode,
    { key = 'Backspace', mods = 'NONE', action = act.CopyMode 'MoveLeft' }
  )
end

return {
  key_tables = {
    copy_mode = copy_mode,
  },
}
```

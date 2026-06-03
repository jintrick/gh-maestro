---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/ActivateCopyMode.md
original_title: ActivateCopyMode
fetched_at: 2026-05-31T22:38:59.950996+00:00
---

# `ActivateCopyMode`

{{since('20200607-144723-74889cd4')}}

Activates copy mode!

```lua
config.keys = {
  { key = 'X', mods = 'CTRL', action = wezterm.action.ActivateCopyMode },
}
```

[Learn more about copy mode](../../../copymode.md)


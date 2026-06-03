---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/HideApplication.md
original_title: HideApplication
fetched_at: 2026-05-31T22:39:00.118224+00:00
---

# `HideApplication`

On macOS, hide the WezTerm application.

```lua
config.keys = {
  { key = 'h', mods = 'CMD', action = wezterm.action.HideApplication },
}
```

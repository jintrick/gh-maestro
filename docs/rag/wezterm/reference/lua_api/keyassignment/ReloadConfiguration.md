---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/ReloadConfiguration.md
original_title: ReloadConfiguration
fetched_at: 2026-05-31T22:39:00.203466+00:00
---

# `ReloadConfiguration`

Explicitly reload the configuration.

```lua
config.keys = {
  {
    key = 'r',
    mods = 'CMD|SHIFT',
    action = wezterm.action.ReloadConfiguration,
  },
}
```



---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/config/automatically_reload_config.md
original_title: automatically_reload_config
fetched_at: 2026-05-31T22:38:59.116444+00:00
---

---
tags:
  - reload
---
# `automatically_reload_config`

{{since('20201031-154415-9614e117')}}

When true (the default), watch the config file and reload it
automatically when it is detected as changing.
When false, you will need to manually trigger a config reload
with a key bound to the action [ReloadConfiguration](../keyassignment/ReloadConfiguration.md).

For example, to disable auto config reload:

```lua
config.automatically_reload_config = false
```

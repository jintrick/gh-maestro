---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/ActivateLastTab.md
original_title: ActivateLastTab
fetched_at: 2026-05-31T22:38:59.955995+00:00
---

# `ActivateLastTab`

{{since('20210404-112810-b63a949d')}}

Activate the previously active tab. If there is none, it will do nothing.

```lua
config.leader = { key = 'a', mods = 'CTRL' }
config.keys = {
  -- CTRL-a, followed by CTRL-o will switch back to the last active tab
  {
    key = 'o',
    mods = 'LEADER|CTRL',
    action = wezterm.action.ActivateLastTab,
  },
}
```

See [ActivateTab](ActivateTab.md) for a way to activate a tab based on its position/index.


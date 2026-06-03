---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/CopyMode/MoveBackwardSemanticZone.md
original_title: MoveBackwardSemanticZone
fetched_at: 2026-05-31T22:39:00.362833+00:00
---

# CopyMode `MoveBackwardSemanticZone`

{{since('20220903-194523-3bb1ed61')}}

Moves the CopyMode cursor position one semantic zone to the left.

See [Shell Integration](../../../../shell-integration.md) for more information
about semantic zones.

```lua
local wezterm = require 'wezterm'
local act = wezterm.action

return {
  key_tables = {
    copy_mode = {
      {
        key = 'z',
        mods = 'NONE',
        action = act.CopyMode 'MoveBackwardSemanticZone',
      },
    },
  },
}
```


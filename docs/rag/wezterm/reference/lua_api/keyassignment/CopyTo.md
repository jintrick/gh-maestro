---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/CopyTo.md
original_title: CopyTo
fetched_at: 2026-05-31T22:39:00.080225+00:00
---

# `CopyTo(destination)`

Copy the selection to the specified clipboard buffer.

Possible values for destination are:

* `Clipboard` - copy the text to the system clipboard.
* `PrimarySelection` - Copy the text to the primary selection buffer (applicable to X11 and some Wayland systems only)
* `ClipboardAndPrimarySelection` - Copy to both the clipboard and the primary selection.

```lua
config.keys = {
  {
    key = 'C',
    mods = 'CTRL',
    action = wezterm.action.CopyTo 'ClipboardAndPrimarySelection',
  },
}
```

{{since('20220319-142410-0fcdea07')}}

`PrimarySelection` is now also supported on Wayland systems that support [primary-selection-unstable-v1](https://wayland.app/protocols/primary-selection-unstable-v1) or the older Gtk primary selection protocol.

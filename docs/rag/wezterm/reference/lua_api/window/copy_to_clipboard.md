---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/window/copy_to_clipboard.md
original_title: copy_to_clipboard
fetched_at: 2026-05-31T22:39:01.264299+00:00
---

# window:copy_to_clipboard(text \[,clipboard\])

{{since('20220807-113146-c2fee766')}}

Puts `text` into the specified `clipboard`.

Clipboard can be one of:

* `"Clipboard"` - the system clipboard
* `"PrimarySelection"` - the primary selection buffer (applicable to X11 and some Wayland systems only)
* `"ClipboardAndPrimarySelection"` - both the system clipboard and the primary selection.  This is the default if you don't specify the clipboard.

Note that updating the clipboard is asynchronous; this method will return
immediately while the clipboard is updated a few moments later in another
thread. If you need to ensure that the published text is visible to other
applications before you trigger some other action in your lua code then you may
need to add a short sleep to allow for that to complete.

```lua
window:copy_to_clipboard 'put this text in the clipboard and primary selection!'
```

```lua
window:copy_to_clipboard('put me in the clipboard only', 'Clipboard')
```

```lua
window:copy_to_clipboard(
  'put me in the primary selection',
  'PrimarySelection'
)
```


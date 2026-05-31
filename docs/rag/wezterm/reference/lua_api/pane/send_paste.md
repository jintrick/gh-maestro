---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/pane/send_paste.md
original_title: send_paste
fetched_at: 2026-05-31T22:39:00.742081+00:00
---

# `pane:send_paste(text)`

{{since('20220624-141144-bd1b7c5d')}}

Sends the supplied `text` string to the input of the pane as if it
were pasted from the clipboard, except that the clipboard is not involved.
Newlines are rewritten according to the
[`canonicalize_pasted_newlines`](../config/canonicalize_pasted_newlines.md) setting.

If the terminal attached to the pane is set to bracketed paste mode then
the text will be sent as a bracketed paste, and newlines will not be rewritten.

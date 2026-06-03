---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/MuxDomain/detach.md
original_title: detach
fetched_at: 2026-05-31T22:39:00.552225+00:00
---

# `domain:detach()`

{{since('20230320-124340-559cb7b0')}}

Attempts to detach the domain.

Detaching a domain causes it to disconnect and remove its set of windows, tabs
and panes from the local GUI. Detaching does not cause those panes to close; if
or when you later attach to the domain, they'll still be there.

Not every domain supports detaching, and will log an error to the error
log/debug overlay.

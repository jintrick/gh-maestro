---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/config/check_for_updates.md
original_title: check_for_updates
fetched_at: 2026-05-31T22:38:59.180919+00:00
---

---
tags:
  - updates
---
# `check_for_updates` & `check_for_updates_interval_seconds`

Wezterm checks regularly if there is a new stable version available
on github, and shows a simple UI to let you know about the update
(See [show_update_window](show_update_window.md) to control this UI).

By default it is checked once every 24 hours.

NOTE that it doesn't automatically download the release.
No data are collected for the wezterm project as part of this.

Set `check_for_updates` to `false` to disable this completely or set
`check_for_updates_interval_seconds` for an alternative update interval.

```lua
config.check_for_updates = true
config.check_for_updates_interval_seconds = 86400
```

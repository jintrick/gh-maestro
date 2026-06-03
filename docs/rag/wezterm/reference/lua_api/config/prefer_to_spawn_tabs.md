---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/config/prefer_to_spawn_tabs.md
original_title: prefer_to_spawn_tabs
fetched_at: 2026-05-31T22:38:59.587894+00:00
---

---
tags:
  - spawn
---

# `prefer_to_spawn_tabs = false`

{{since('20240203-110809-5046fc22')}}

If set to `true`, launching a new instance of `wezterm` will prefer to
spawn a new tab when it is able to connect to your already-running GUI
instance.

Otherwise, it will spawn a new window.

The default value for this option is `false`.

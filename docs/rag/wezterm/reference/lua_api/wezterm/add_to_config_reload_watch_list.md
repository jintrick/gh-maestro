---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/wezterm/add_to_config_reload_watch_list.md
original_title: add_to_config_reload_watch_list
fetched_at: 2026-05-31T22:39:00.769470+00:00
---

---
title: wezterm.add_to_config_reload_watch_list
tags:
 - reload
---

# wezterm.add_to_config_reload_watch_list(path)

{{since('20210814-124438-54e29167')}}

Adds `path` to the list of files that are watched for config changes.
If [automatically_reload_config](../config/automatically_reload_config.md)
is enabled, then the config will be reloaded when any of the files
that have been added to the watch list have changed.

{{since('20220807-113146-c2fee766')}}

This function is now called implicitly when you `require` a lua file.

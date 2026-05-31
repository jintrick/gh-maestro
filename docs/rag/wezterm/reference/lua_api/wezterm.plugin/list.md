---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/wezterm.plugin/list.md
original_title: list
fetched_at: 2026-05-31T22:39:01.153323+00:00
---

# list function

{{since('20230320-124340-559cb7b0')}}

Will return a table array listing all the plugin repos in the plugin directory

Each entry has three fields:

* `url`: The URL of the plugin repo, as provided to the `wezterm.plugin.require` function
* `component`: The encoded name of the plugin, derived from the repo URL
* `plugin_dir`: The absolute location of the plugin checkout in the Wezterm runtime directory. Use this to set the plugin path if needed

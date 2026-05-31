---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/wezterm.plugin/require.md
original_title: require
fetched_at: 2026-05-31T22:39:01.161323+00:00
---

# Function require

{{since('20230320-124340-559cb7b0')}}

Will clone the plugin repo if it doesn't already
exist and store it in the runtime dir under `plugins/NAME` where
`NAME` is derived from the repo URL. Once cloned, the repo is
NOT automatically updated when `require` is called again.

The function takes a single string parameter, the Git repo URL

Only HTTP(S) or local filesystem repos are allowed for the git URL.

```lua
local remote_plugin = wezterm.plugin.require 'https://github.com/owner/repo'
local local_plugin =
  wezterm.plugin.require 'file:///Users/developer/projects/my.Plugin'
```

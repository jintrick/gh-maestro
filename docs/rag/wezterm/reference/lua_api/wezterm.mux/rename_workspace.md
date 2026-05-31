---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/wezterm.mux/rename_workspace.md
original_title: rename_workspace
fetched_at: 2026-05-31T22:39:01.144322+00:00
---

# `wezterm.mux.rename_workspace(old, new)`

{{since('20230408-112425-69ae8472')}}

Renames the workspace *old* to *new*.

```lua
wezterm.mux.rename_workspace(
  wezterm.mux.get_active_workspace(),
  'something different'
)
```

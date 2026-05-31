---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/wezterm/shell_join_args.md
original_title: shell_join_args
fetched_at: 2026-05-31T22:39:00.978324+00:00
---

---
title: wezterm.shell_join_args
tags:
 - utility
 - open
 - spawn
 - string
---
# wezterm.shell_join_args({"foo", "bar"})

{{since('20220807-113146-c2fee766')}}

`wezterm.shell_join_args` joins together its array arguments by applying posix
style shell quoting on each argument and then adding a space.

```
> wezterm.shell_join_args{"foo", "bar"}
"foo bar"
> wezterm.shell_join_args{"hello there", "you"}
"\"hello there\" you"
```

This is useful to safely construct command lines that you wish to pass to the shell.

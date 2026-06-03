---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/wezterm/shell_split.md
original_title: shell_split
fetched_at: 2026-05-31T22:39:00.987324+00:00
---

---
title: wezterm.shell_split
tags:
 - utility
 - open
 - spawn
 - string
---
# wezterm.shell_split(line)

{{since('20220807-113146-c2fee766')}}

Splits a command line into an argument array according to posix shell rules.

```
> wezterm.shell_split("ls -a")
[
    "ls",
    "-a",
]
```

```
> wezterm.shell_split("echo 'hello there'")
[
    "echo",
    "hello there",
]
```

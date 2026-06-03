---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/wezterm/shell_quote_arg.md
original_title: shell_quote_arg
fetched_at: 2026-05-31T22:39:00.980324+00:00
---

---
title: wezterm.shell_quote_arg
tags:
 - utility
 - open
 - spawn
 - string
---
# wezterm.shell_quote_arg(string)

{{since('20220807-113146-c2fee766')}}

Quotes its single argument using posix shell quoting rules.

```
> wezterm.shell_quote_arg("hello there")
"\"hello there\""
```

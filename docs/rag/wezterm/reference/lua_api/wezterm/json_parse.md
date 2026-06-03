---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/wezterm/json_parse.md
original_title: json_parse
fetched_at: 2026-05-31T22:39:00.900746+00:00
---

---
title: wezterm.json_parse
tags:
 - utility
 - json
---


# `wezterm.json_parse(string)`

{{since('20220807-113146-c2fee766')}}

Parses the supplied string as json and returns the equivalent lua values:

```
> wezterm.json_parse('{"foo":"bar"}')
{
    "foo": "bar",
}
```

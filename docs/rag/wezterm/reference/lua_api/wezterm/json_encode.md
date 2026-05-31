---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/wezterm/json_encode.md
original_title: json_encode
fetched_at: 2026-05-31T22:39:00.898636+00:00
---

---
title: wezterm.json_encode
tags:
 - utility
 - json
---

# `wezterm.json_encode(value)`

{{since('20220807-113146-c2fee766')}}

Encodes the supplied lua value as json:

```
> wezterm.json_encode({foo = "bar"})
"{\"foo\":\"bar\"}"
```

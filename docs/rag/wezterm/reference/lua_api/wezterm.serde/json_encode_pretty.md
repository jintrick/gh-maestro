---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/wezterm.serde/json_encode_pretty.md
original_title: json_encode_pretty
fetched_at: 2026-05-31T22:39:01.194367+00:00
---

# `wezterm.serde.json_encode_pretty(value)`

{{since('nightly')}}

Encodes the supplied `lua` value as a pretty-printed string of `json`: 

```
> wezterm.serde.json_encode_pretty({foo = "bar"})
"{\n  \"foo\": \"bar\"\n}"
```

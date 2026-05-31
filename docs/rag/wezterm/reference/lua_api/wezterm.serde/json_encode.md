---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/wezterm.serde/json_encode.md
original_title: json_encode
fetched_at: 2026-05-31T22:39:01.186094+00:00
---

# `wezterm.serde.json_encode(value)`

{{since('nightly')}}

Encodes the supplied `lua` value as `json`:

```
> wezterm.serde.json_encode({foo = "bar"})
"{\"foo\":\"bar\"}"
```

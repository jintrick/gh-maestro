---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/wezterm.serde/json_decode.md
original_title: json_decode
fetched_at: 2026-05-31T22:39:01.178096+00:00
---

# `wezterm.serde.json_decode(string)`

{{since('nightly')}}

Parses the supplied string as `json` and returns the equivalent `lua` values:

```
> wezterm.serde.json_decode('{"foo":"bar"}')
{
    "foo": "bar",
}
```

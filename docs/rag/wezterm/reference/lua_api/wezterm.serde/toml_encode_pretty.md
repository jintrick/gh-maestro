---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/wezterm.serde/toml_encode_pretty.md
original_title: toml_encode_pretty
fetched_at: 2026-05-31T22:39:01.201367+00:00
---

# `wezterm.serde.toml_encode_pretty(value)`

{{since('nightly')}}

Encodes the supplied `lua` value as a pretty-printed string of `toml`: 

```
> wezterm.serde.toml_encode_pretty({foo = { "bar", "baz", "qux" } })
"foo = [\n    \"bar\",\n    \"baz\",\n    \"qux\",\n]\n"
```

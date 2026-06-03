---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/wezterm.serde/toml_decode.md
original_title: toml_decode
fetched_at: 2026-05-31T22:39:01.196367+00:00
---

# `wezterm.serde.toml_decode(string)`

{{since('nightly')}}

Parses the supplied string as `toml` and returns the equivalent `lua` values:

```
> wezterm.serde.toml_decode('foo = "bar"')
{
    "foo": "bar",
}
```

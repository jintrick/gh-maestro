---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/wezterm.serde/toml_encode.md
original_title: toml_encode
fetched_at: 2026-05-31T22:39:01.199367+00:00
---

# `wezterm.serde.toml_encode(value)`

{{since('nightly')}}

Encodes the supplied `lua` value as `toml`:

```
> wezterm.serde.toml_encode({foo = { "bar", "baz", "qux" } })
"foo = [\"bar\", \"baz\", \"qux\"]\n"
```

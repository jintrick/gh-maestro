---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/wezterm.serde/yaml_encode.md
original_title: yaml_encode
fetched_at: 2026-05-31T22:39:01.210367+00:00
---

# `wezterm.serde.yaml_encode(value)`

{{since('nightly')}}

Encodes the supplied `lua` value as `yaml`:

```
> wezterm.serde.yaml_encode({foo = "bar"})
"foo: bar\n"
```

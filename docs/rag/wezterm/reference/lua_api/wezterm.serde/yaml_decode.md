---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/wezterm.serde/yaml_decode.md
original_title: yaml_decode
fetched_at: 2026-05-31T22:39:01.203367+00:00
---

# `wezterm.serde.yaml_decode(string)`

{{since('nightly')}}

Parses the supplied string as `yaml` and returns the equivalent `lua` values:

```
> wezterm.serde.yaml_decode('---\n# comment\nfoo: "bar"')
{
    "foo": "bar",
}
```

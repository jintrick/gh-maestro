---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/config/key_map_preference.md
original_title: key_map_preference
fetched_at: 2026-05-31T22:38:59.491464+00:00
---

---
tags:
  - keys
---
# `key_map_preference = "Mapped"`

{{since('20220408-101518-b908e2dd')}}

Controls how keys without an explicit `phys:` or `mapped:` prefix are treated.

If `key_map_preference = "Mapped"` (the default), then `mapped:` is assumed. If
`key_map_preference = "Physical"` then `phys:` is assumed.

Default key assignments also respect `key_map_preference`.


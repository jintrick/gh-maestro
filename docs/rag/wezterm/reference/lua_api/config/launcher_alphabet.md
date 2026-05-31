---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/config/launcher_alphabet.md
original_title: launcher_alphabet
fetched_at: 2026-05-31T22:38:59.495409+00:00
---

---
tags:
  - launcher
---
# `launcher_alphabet`

{{since('nightly')}}

Specify a string of unique characters. The characters in the string are used
to calculate one or two key press shortcuts that can be used to quickly choose from
the Launcher when in the default mode. Defaults to:
`"1234567890abcdefghilmnopqrstuvwxyz"`. (Without j/k so they can be used for movement
up and down.)

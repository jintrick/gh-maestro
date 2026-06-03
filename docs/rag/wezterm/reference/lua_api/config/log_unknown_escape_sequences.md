---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/config/log_unknown_escape_sequences.md
original_title: log_unknown_escape_sequences
fetched_at: 2026-05-31T22:38:59.500410+00:00
---

# `log_unknown_escape_sequences = false`

{{since('20230320-124340-559cb7b0')}}

When set to true, wezterm will log warnings when it receives escape
sequences which it does not understand.  Those warnings are harmless
and are useful primarily by the maintainer to discover new and
interesting escape sequences.

In previous versions, there was no option to control this,
and wezterm would always log warnings for unknown escape
sequences.

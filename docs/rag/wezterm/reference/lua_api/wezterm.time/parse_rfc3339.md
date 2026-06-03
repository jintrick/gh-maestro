---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/wezterm.time/parse_rfc3339.md
original_title: parse_rfc3339
fetched_at: 2026-05-31T22:39:01.224366+00:00
---

# `wezterm.time.parse_rfc3339(str)`

{{since('20220807-113146-c2fee766')}}

Parses a string that is formatted according to [RFC
3339](https://datatracker.ietf.org/doc/html/rfc3339) and returns a
[Time](Time/index.md) object representing that time.

Will raise an error if the input string cannot be parsed according to RFC 3339.


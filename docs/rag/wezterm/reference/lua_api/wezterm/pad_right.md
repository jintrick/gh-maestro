---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/wezterm/pad_right.md
original_title: pad_right
fetched_at: 2026-05-31T22:39:00.944637+00:00
---

---
title: wezterm.pad_right
tags:
 - utility
 - string
---
# wezterm.pad_right(string, min_width)

{{since('20210502-130208-bff6815d')}}

Returns a copy of `string` that is at least `min_width` columns
(as measured by [wezterm.column_width](column_width.md)).

If the string is shorter than `min_width`, spaces are added to
the right end of the string.

For example, `wezterm.pad_right("o", 3)` returns `"o  "`.

See also: [wezterm.truncate_left](truncate_left.md), [wezterm.pad_left](pad_left.md).




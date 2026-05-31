---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/config/treat_east_asian_ambiguous_width_as_wide.md
original_title: treat_east_asian_ambiguous_width_as_wide
fetched_at: 2026-05-31T22:38:59.778104+00:00
---

---
tags:
  - unicode
---
# `treat_east_asian_ambiguous_width_as_wide = false`

{{since('20220624-141144-bd1b7c5d')}}

Unicode defines a number of codepoints as having [Ambiguous
Width](http://www.unicode.org/reports/tr11/#Ambiguous). These are characters
whose width resolves differently according to context that is typically absent
from the monospaced world of the terminal.

WezTerm will by default treat ambiguous width as occupying a single cell.

When `treat_east_asian_ambiguous_width_as_wide = true` WezTerm will treat them
as being two cells wide.

Note that changing this setting may have consequences for layout in text UI
applications if their expectation of width differs from your choice of
configuration.

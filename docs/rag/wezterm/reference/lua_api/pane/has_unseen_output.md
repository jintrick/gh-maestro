---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/pane/has_unseen_output.md
original_title: has_unseen_output
fetched_at: 2026-05-31T22:39:00.709881+00:00
---

# `pane:has_unseen_output()`

{{since('20220319-142410-0fcdea07')}}

Returns true if there has been output in the pane since the last time
the time the pane was focused.

See also [PaneInformation.has_unseen_output](../PaneInformation.md) for
an example using equivalent information to color tabs based on this state.


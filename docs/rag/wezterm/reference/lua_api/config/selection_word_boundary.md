---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/config/selection_word_boundary.md
original_title: selection_word_boundary
fetched_at: 2026-05-31T22:38:59.612895+00:00
---

---
tags:
  - mouse
---
# `selection_word_boundary`

{{since('20210203-095643-70a364eb')}}

Configures the boundaries of a word, thus what is selected when doing
a word selection with the mouse.
(See mouse actions [SelectTextAtMouseCursor](../keyassignment/SelectTextAtMouseCursor.md) & [ExtendSelectionToMouseCursor](../keyassignment/ExtendSelectionToMouseCursor.md) with the mode argument set to `Word`)

Defaults to ``" \t\n{}[]()\"'`"``.

For example, to always include spaces and newline when selecting a word, but stop on punctuations:
```lua
config.selection_word_boundary = '{}[]()"\'`.,;:'
```

---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/cli/cli/activate-pane-direction.md
original_title: activate-pane-direction
fetched_at: 2026-05-31T22:36:30.208355+00:00
---

# `wezterm cli activate-pane-direction DIRECTION`

{{since('20221119-145034-49b9839f')}}

*Run `wezterm cli activate-pane-direction --help` to see more help*

Changes the activate pane to the one in the specified direction.

Possible values for `DIRECTION` are shown below; the direction is matched
ignoring case so you can use `left` rather than `Left`:

* `Left`, `Right`, `Up`, `Down` to activate based on direction
* `Next`, `Prev` to cycle based on the ordinal position in the pane tree.

## Synopsis

```console
{% include "../../examples/cmd-synopsis-wezterm-cli-activate-pane-direction--help.txt" %}
```

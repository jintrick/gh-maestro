---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/wezterm.mux/set_default_domain.md
original_title: set_default_domain
fetched_at: 2026-05-31T22:39:01.148323+00:00
---

# `wezterm.mux.set_default_domain(MuxDomain)`

{{since('20230320-124340-559cb7b0')}}

Assign a new default domain in the mux.

The domain that you assign here will override any configured
[default_domain](../config/default_domain.md) or the implicit assignment of the
default domain that may have happened as a result of starting wezterm via
`wezterm connect` or `wezterm serial`.

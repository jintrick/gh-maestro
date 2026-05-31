---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/color/delta_e.md
original_title: delta_e
fetched_at: 2026-05-31T22:38:59.019690+00:00
---

# `color:delta_e(color)`

{{since('20220807-113146-c2fee766')}}

Computes the CIEDE2000 DeltaE value representing the difference
between the two colors.

A value:

* <= 1.0: difference is not perceptible by the human eye
* 1-2: difference is perceptible through close observation
* 2-10: difference is perceptible at a glance
* 11-49: Colors are more similar than the opposite
* 50-99: Colors are more opposite than similar
* 100: Colors are exactly the opposite


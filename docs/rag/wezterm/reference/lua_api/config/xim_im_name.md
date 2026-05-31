---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/config/xim_im_name.md
original_title: xim_im_name
fetched_at: 2026-05-31T22:38:59.930740+00:00
---

---
tags:
  - keys
---
# `xim_im_name`

{{since('20220101-133340-7edc5b5a')}}

Explicitly set the name of the IME server to which wezterm will connect
via the XIM protocol when using X11 and [use_ime](use_ime.md) is `true`.

By default, this option is not set which means that wezterm will consider
the value of the `XMODIFIERS` environment variable.

If for some reason the environment isn't set up correctly, or you want
to quickly evaluate a different input method server, then you could
update your config to specify it explicitly:

```lua
config.xim_im_name = 'fcitx'
```

will cause wezterm to connect to fcitx regardless of the value of `XMODIFIERS`.


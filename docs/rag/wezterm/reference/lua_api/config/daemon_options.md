---
source_url: https://github.com/wezterm/wezterm/blob/main/docs/config/lua/config/daemon_options.md
original_title: daemon_options
fetched_at: 2026-05-31T22:38:59.234563+00:00
---

---
tags:
  - multiplexing
---
# `daemon_options`

Allows configuring the multiplexer (mux) server and how it places itself into
the background to run as a daemon process.

You should not normally need to configure this setting; the defaults should
be sufficient in most cases.

There are three fields supported:
* `pid_file` - specify the location of the pid and lock file.  The default location is `$XDG_RUNTIME_DIR/wezterm/pid` on X11/Wayland systems, or `$HOME/.local/share/wezterm/pid`
* `stdout` - specifies where a log of the stdout stream from the daemon will be placed.  The default is `$XDG_RUNTIME_DIR/wezterm/stdout` on X11/Wayland systems, or `$HOME/.local/share/wezterm/stdout`.
* `stderr` - specifies where a log of the stderr stream from the daemon will be placed.  The default is `$XDG_RUNTIME_DIR/wezterm/stderr` on X11/Wayland systems, or `$HOME/.local/share/wezterm/stderr`.

```lua
config.daemon_options = {
  stdout = '/some/where/stdout',
  stderr = '/some/where/stderr',
  pid_file = '/some/where/pid_file',
}
```

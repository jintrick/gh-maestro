---
source_url: https://github.com/openwong2kim/wmux/blob/main/src/main/pty/shell-hooks/README.md
original_title: README
fetched_at: 2026-05-30T16:00:11.398995+00:00
---

# wmux Shell Integration Hooks

Shell hook scripts that emit OSC escape sequences so the wmux host can track
terminal state (CWD, git branch) without polling.

## Protocol

| OSC Code | Purpose | Format |
|----------|---------|--------|
| 7 | Current working directory | `\x1b]7;file://hostname/path\x07` |
| 7727 | Git branch (wmux custom) | `\x1b]7727;branch-name\x07` |

## Per-shell strategy

### PowerShell (`pwsh.ps1`)
Injected via `-Command . '<path>'` argument when spawning the PTY.
Overrides the `prompt` function; preserves the original as `__wmux_original_prompt`.

### Bash (`bash.sh`)
Injected via `--init-file` or sourced from `.bashrc` snippet.
Appends a hook function to `PROMPT_COMMAND`; preserves existing value.

### CMD (`cmd.exe`)
CMD has no scriptable prompt hook mechanism. Instead, the PTY spawn sets the
`PROMPT` environment variable to include an ANSI OSC 7 sequence:

```
PROMPT=$E]7;file://hostname/$P$G$E\$P$G
```

This causes `cmd.exe` to emit OSC 7 with the CWD on every prompt render.

**Limitations:**
- Git branch reporting (OSC 7727) is **not supported** in CMD because there is
  no hook that runs arbitrary commands on each prompt.
- The `$P` expansion uses backslashes; the host normalises path separators.

## Duplicate-load guard

All scripts set `WMUX_SHELL_HOOK_ACTIVE=1` and exit early if it is already set.
This prevents double-registration when a shell config file sources the hook and
wmux also injects it via spawn arguments.

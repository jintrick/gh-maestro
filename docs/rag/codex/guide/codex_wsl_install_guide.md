---
source_url: https://developers.openai.com/codex/llms-full.txt
original_title: Install and run Codex in WSL
fetched_at: 2026-07-03T06:05:55.863Z
---

# Install and run Codex in WSL

curl -fsSL https://chatgpt.com/codex/install.sh | sh
codex
```

### Working on code inside WSL

- Working in Windows-mounted paths like <code>/mnt/c/...</code> can be slower than working in Windows-native paths. Keep your repositories under your Linux home directory (like <code>~/code/my-app</code>) for faster I/O and fewer symlink and permission issues:
  ```bash
  mkdir -p ~/code && cd ~/code
  git clone https://github.com/your/repo.git
  cd repo
  ```
- If you need Windows access to files, they're under <code>\\wsl$\Ubuntu\home\&lt;user&gt;</code> in Explorer.

## Troubleshooting and FAQ

If you are troubleshooting a managed Windows machine, start with the native
sandbox mode, Windows version, and any policy error shown by Codex. Most native
Windows support issues come from sandbox setup, logon rights, or filesystem
permissions rather than from the editor itself.

My native sandbox setup failed

If Codex cannot complete the `elevated` sandbox setup, the most common causes
are:

- the Windows UAC or administrator prompt was declined,
- the machine does not allow local user or group creation,
- the machine does not allow firewall rule changes,
- the machine blocks the logon rights needed by the sandbox users,
- or another enterprise policy blocks part of the setup flow.

What to try:

1. Try the `elevated` sandbox setup again and approve the administrator prompt
   if your environment allows it.
2. If your company laptop blocks this, ask your IT team whether the machine
   allows administrator-approved setup for local user/group creation, firewall
   configuration, and the required sandbox-user logon rights.
3. If the default setup still fails, use the `unelevated` sandbox so you can
   continue working while the issue is investigated.

Codex switched me to the unelevated sandbox

This means Codex could not finish the stronger `elevated` sandbox setup on your
machine.

- Codex can still run in a sandboxed mode.
- It still applies ACL-based filesystem boundaries, but it does not use the
  separate sandbox-user boundary from `elevated` and has weaker network
  isolation.
- This is a useful fallback, but not the preferred long-term enterprise
  configuration.

If you are on a managed enterprise laptop, the best long-term fix is usually to
get the `elevated` sandbox working with help from your IT team.

I see Windows error 1385

If sandboxed commands fail with error `1385`, Windows is denying the logon type
the sandbox user needs in order to start the command.

In practice, this usually means Codex created the sandbox users successfully,
but Windows policy is still preventing those users from launching sandboxed
commands.

What to do:

1. Ask your IT team whether the device policy grants the required logon rights
   to the Codex-created sandbox users.
2. Compare group policy or OU differences if the issue affects only some
   machines or teams.
3. If you need to keep working immediately, use the `unelevated` sandbox while
   the policy issue is investigated.
4. Send `CODEX_HOME/.sandbox/sandbox.log` along with your Windows version and a
   short description of the failure.

Codex warns that some folders are writable by Everyone

Codex may warn that some folders are writable by `Everyone`.

If you see this warning, Windows permissions on those folders are too broad for
the sandbox to fully protect them.

What to do:

1. Review the folders Codex lists in the warning.
2. Remove `Everyone` write access from those folders if that is appropriate in
   your environment.
3. Restart Codex or re-run the sandbox setup after those permissions are
   corrected.

If you are not sure how to change those permissions, ask your IT team for help.

Sandboxed commands cannot reach the network

Some Codex tasks are intentionally run without outbound network access,
depending on the permissions mode in use.

If a task fails because it cannot reach the network:

1. Check whether the task was supposed to run with network disabled.
2. If you expected network access, restart Codex and try again.
3. If the issue keeps happening, collect the sandbox log so the team can check
   whether the machine is in a partial or broken sandbox state.

Sandboxing worked before and then stopped

This can happen after:

- moving a repo or workspace,
- changing machine permissions,
- changing Windows policies,
- or other system configuration changes.

What to try:

1. Restart Codex.
2. Try the `elevated` sandbox setup again.
3. If that does not fix it, use the `unelevated` sandbox as a temporary
   fallback.
4. Collect the sandbox log for review.

I need to send diagnostics to OpenAI

If you still have problems, send:

- `CODEX_HOME/.sandbox/sandbox.log`

It is also helpful to include:

- a short description of what you were trying to do,
- whether the `elevated` sandbox failed or the `unelevated` sandbox was used,
- any error message shown in the app,
- whether you saw `1385` or another Windows or PowerShell error,
- and whether you are on Windows 11 or Windows 10.

Do not send:

- the contents of `CODEX_HOME/.sandbox-secrets/`

The IDE extension is installed but unresponsive

Your system may be missing C++ development tools, which some native dependencies require:

- Visual Studio Build Tools (C++ workload)
- Microsoft Visual C++ Redistributable (x64)
- With `winget`, run `winget install --id Microsoft.VisualStudio.2022.BuildTools -e`

Then fully restart VS Code after installation.

Large repositories feel slow in WSL

- Make sure you're not working under <code>/mnt/c</code>. Move the repository to WSL (for example, <code>~/code/...</code>).
- Increase memory and CPU for WSL if needed; update WSL to the latest version:
  ```powershell
  wsl --update
  wsl --shutdown
  ```

VS Code in WSL cannot find codex

Verify the binary exists and is on PATH inside WSL:

```bash
which codex || echo "codex not found"
```

If the binary isn't found, install it by [following the instructions](#use-codex-cli-with-wsl) above.

---

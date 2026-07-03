---
source_url: https://developers.openai.com/codex/llms-full.txt
original_title: Codex Windows WSL and Sandbox Configuration Guide
fetched_at: 2026-07-03T06:05:55.863Z
---

# Windows

Use Codex on Windows with the native [Codex app](https://developers.openai.com/codex/app/windows), the
[CLI](https://developers.openai.com/codex/cli), or the [IDE extension](https://developers.openai.com/codex/ide).

The Codex app on Windows supports core workflows such as parallel agent threads,
worktrees, automations, Git functionality, the in-app browser, artifact previews,
plugins, and skills.

<div class="mb-8">
  </div>

Depending on the surface and your setup, Codex can run on Windows in three
practical ways:

- natively on Windows with the stronger `elevated` sandbox,
- natively on Windows with the fallback `unelevated` sandbox,
- or inside [Windows Subsystem for Linux 2](https://learn.microsoft.com/en-us/windows/wsl/install) (WSL2), which uses the Linux sandbox implementation.

## Windows sandbox

When you run Codex natively on Windows, agent mode uses a Windows sandbox to
block filesystem writes outside the working folder and prevent network access
without your explicit approval.

Native Windows sandbox support includes two modes that you can configure in
`config.toml`:

```toml
[windows]
sandbox = "elevated" # or "unelevated"
```

`elevated` is the preferred native Windows sandbox. It uses dedicated
lower-privilege sandbox users, filesystem permission boundaries, firewall
rules, and local policy changes needed for commands that run in the sandbox.

`unelevated` is the fallback native Windows sandbox. It runs commands with a
restricted Windows token derived from your current user, applies ACL-based
filesystem boundaries, and uses environment-level offline controls instead of
the dedicated offline-user firewall rule. It's weaker than `elevated`, but it
is still useful when administrator-approved setup is blocked by local or
enterprise policy.

If both modes are available, use `elevated`. If the default native sandbox
doesn't work in your environment, use `unelevated` as a fallback while you
troubleshoot the setup.

Enterprise administrators can constrain which native sandbox implementations
Codex can use through [`requirements.toml`](https://developers.openai.com/codex/enterprise/managed-configuration#admin-enforced-requirements-requirementstoml):

```toml
[windows]
allowed_sandbox_implementations = ["elevated"]
```

This example requires the `elevated` sandbox and prevents users from falling
back to `unelevated`. To permit either implementation, include both values;
Codex prefers `elevated` when no mode is selected. See the
[`requirements.toml` reference](https://developers.openai.com/codex/config-reference#requirementstoml) for
the supported values.

By default, both sandbox modes also use a private desktop for stronger UI
isolation. Set `windows.sandbox_private_desktop = false` only if you need the
older `Winsta0\\Default` behavior for compatibility.

### Sandbox permissions

Running Codex in full access mode means Codex is not limited to your project
  directory and might perform unintentional destructive actions that can lead to
  data loss. For safer automation, keep sandbox boundaries in place and use
  [rules](https://developers.openai.com/codex/rules) for specific exceptions, or set your [approval policy to
  never](https://developers.openai.com/codex/agent-approvals-security#run-without-approval-prompts) to have
  Codex attempt to solve problems without asking for escalated permissions,
  based on your [approval and security setup](https://developers.openai.com/codex/agent-approvals-security).

### Windows version matrix

| Windows version                  | Support level   | Notes                                                                                                                                                                                 |
| -------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows 11                       | Recommended     | Best baseline for Codex on Windows. Use this if you are standardizing an enterprise deployment.                                                                                       |
| Recent, fully updated Windows 10 | Best effort     | Can work, but is less reliable than Windows 11. For Windows 10, Codex depends on modern console support, including ConPTY. In practice, Windows 10 version 1809 or newer is required. |
| Older Windows 10 builds          | Not recommended | More likely to miss required console components such as ConPTY and more likely to fail in enterprise setups.                                                                          |

Additional environment assumptions:

- `winget` should be available. If it's missing, update Windows or install
  the Windows Package Manager before setting up Codex.
- The recommended native sandbox depends on administrator-approved setup.
- Some enterprise-managed devices block the required setup steps even when the
  OS version itself is acceptable.

### Grant sandbox read access

When a command fails because the Windows sandbox can't read a directory, use:

```text
/sandbox-add-read-dir C:\absolute\directory\path
```

The path must be an existing absolute directory. After the command succeeds, later commands that run in the sandbox can read that directory during the current session.

Use the native Windows sandbox by default. The native Windows sandbox offers the best performance and highest speeds while keeping the same security. Choose WSL2 when you
need a Linux-native environment on Windows, when your workflow already lives in
WSL2, or when neither native Windows sandbox mode meets your needs.

## Windows Subsystem for Linux

If you choose WSL2, Codex runs inside the Linux environment instead of using the
native Windows sandbox. This is useful if you need Linux-native tooling on
Windows, if your repositories and developer workflow already live in WSL2, or
if neither native Windows sandbox mode works for your environment.

WSL1 was supported through Codex `0.114`. Starting in Codex `0.115`, the Linux
sandbox moved to `bubblewrap`, so WSL1 is no longer supported.

### Launch VS Code from inside WSL

For step-by-step instructions, see the [official VS Code WSL tutorial](https://code.visualstudio.com/docs/remote/wsl-tutorial).

#### Prerequisites

- Windows with WSL installed. To install WSL, open PowerShell as an administrator, then run `wsl --install` (Ubuntu is a common choice).
- VS Code with the [WSL extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-wsl) installed.

#### Open VS Code from a WSL terminal

```bash

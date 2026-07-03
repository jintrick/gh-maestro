---
source_url: https://developers.openai.com/codex/llms-full.txt
original_title: From your WSL shell
fetched_at: 2026-07-03T06:05:55.863Z
---

# From your WSL shell

cd ~/code/your-project
code .
```

This opens a WSL remote window, installs the VS Code Server if needed, and ensures integrated terminals run in Linux.

#### Confirm you're connected to WSL

- Look for the green status bar that shows `WSL: <distro>`.
- Integrated terminals should display Linux paths (such as `/home/...`) instead of `C:\`.
- You can verify with:

  ```bash
  echo $WSL_DISTRO_NAME
  ```

  This prints your distribution name.

If you don't see "WSL: ..." in the status bar, press `Ctrl+Shift+P`, pick
  `WSL: Reopen Folder in WSL`, and keep your repository under `/home/...` (not
  `C:\`) for best performance.

If the Windows app or project picker does not show your WSL repository, type
  <code>\\wsl$</code> into the file picker or Explorer, then navigate to your
  distro's home directory.

### Use Codex CLI with WSL

Run these commands from an elevated PowerShell or Windows Terminal:

```powershell
# Install default Linux distribution (like Ubuntu)
wsl --install

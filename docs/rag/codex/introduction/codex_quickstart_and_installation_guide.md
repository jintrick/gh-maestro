---
source_url: https://developers.openai.com/codex/llms-full.txt
original_title: Codex Quickstart and Installation Guide
fetched_at: 2026-07-03T06:05:55.863Z
---

# Quickstart

Every ChatGPT plan includes Codex.

You can also use Codex with API credits by signing in with an OpenAI API key.

## Setup

<script
  is:inline
  data-astro-rerun
  set:html={String.raw`
(() => {
  const platform =
    (navigator.userAgentData?.platform || navigator.platform || "").toLowerCase();
  const isDesktopAppPlatform =
    platform.includes("mac") ||
    platform.includes("win") ||
    /macintosh|mac os x|windows|win64|win32/i.test(navigator.userAgent || "");
  if (!isDesktopAppPlatform) return;

  const shouldPreferApp = () => {
    try {
      const url = new URL(window.location.href);
      return !url.searchParams.get("setup");
    } catch {
      return true;
    }
  };

  if (!shouldPreferApp()) return;

  window.__tabsPreferred = window.__tabsPreferred || {};
  window.__tabsPreferred.setup = "app";
})();
`}
/>



<div slot="app">
The Codex app is available on macOS and Windows.

Most Codex app features are available on both platforms. Platform-specific
exceptions are noted in the relevant docs.

<WorkflowSteps variant="headings">
1. Download and install the Codex app

    Download the Codex app for macOS or Windows. Choose the Intel build if you're using an Intel-based Mac.

    <div class="text-sm">
      [Get notified for Linux](https://openai.com/form/codex-app/)
    </div>

2. Open Codex and sign in

   Once you downloaded and installed the Codex app, open it and sign in with your ChatGPT account or an OpenAI API key.

   If you sign in with an OpenAI API key, [some functionality might not be available](https://developers.openai.com/codex/pricing#feature-availability).

3. Select a project

   Choose a project folder that you want Codex to work in.

    If you used the Codex app, CLI, or IDE Extension before you'll see past projects that you worked on.

4. Send your first message

   After choosing the project, make sure **Local** is selected to have Codex work on your machine and send your first message to Codex.

   You can ask Codex anything about the project or your computer in general. Here are some examples:

   <ExampleGallery>
     </ExampleGallery>

   If you need more inspiration, explore [Codex use cases](https://developers.openai.com/codex/use-cases).
   If you're new to Codex, read the [best practices guide](https://developers.openai.com/codex/learn/best-practices).

</WorkflowSteps>


  </div>

  <div slot="ide">
Install the Codex extension for your IDE.

<WorkflowSteps variant="headings">
1. Install the Codex extension

    Download it for your editor:

    - [Download for Visual Studio Code](vscode:extension/openai.chatgpt)
    - [Download for Cursor](cursor:extension/openai.chatgpt)
    - [Download for Windsurf](windsurf:extension/openai.chatgpt)
    - [Download for Visual Studio Code Insiders](https://marketplace.visualstudio.com/items?itemName=openai.chatgpt)

2. Open the Codex panel

    Once installed, the Codex extension appears in the sidebar alongside your other extensions. It may be hidden in the collapsed section. You can move the Codex panel to the right side of the editor if you prefer.

3. Sign in and start your first task

    Sign in with your ChatGPT account or an API key to get started.

    Codex starts in Agent mode by default, which lets it read files, run commands, and write changes in your project directory.
    
    <ExampleGallery>
     </ExampleGallery>

4. Use Git checkpoints

    Codex can modify your codebase, so consider creating Git checkpoints before and after each task so you can easily revert changes if needed.
    If you're new to Codex, read the [best practices guide](https://developers.openai.com/codex/learn/best-practices).
    
    </WorkflowSteps>


  </div>

  <div slot="cli">
The Codex CLI is supported on macOS, Windows, and Linux.

<WorkflowSteps variant="headings">
1. Install the Codex CLI

    On macOS or Linux, use the standalone installer:

    ```bash
    curl -fsSL https://chatgpt.com/codex/install.sh | sh
    ```

    On Windows, run:

    ```powershell
    powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
    ```

    For unattended installs, set `CODEX_NON_INTERACTIVE=1` on the shell that
    runs the downloaded installer. See
    [Environment variables](https://developers.openai.com/codex/environment-variables#installer-variables)
    for details.

    ```bash
    curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh
    ```

    ```powershell
    $env:CODEX_NON_INTERACTIVE=1; irm https://chatgpt.com/codex/install.ps1 | iex
    ```

    You can also install Codex CLI with npm or Homebrew:

    ```bash
    npm install -g @openai/codex
    ```

    ```bash
    brew install --cask codex
    ```

2. Run `codex` and sign in

    Run `codex` in your terminal to get started. You'll be prompted to sign in with your ChatGPT account or an API key.

3. Ask Codex to work in your current directory

    Once authenticated, you can ask Codex to perform tasks in the current directory.

    <ExampleGallery>
     </ExampleGallery>

4. Use Git checkpoints

    Codex can modify your codebase, so consider creating Git checkpoints before and after each task so you can easily revert changes if needed.
    If you're new to Codex, read the [best practices guide](https://developers.openai.com/codex/learn/best-practices).
</WorkflowSteps>

    </div>

  <div slot="cloud">
Use Codex in the cloud at [chatgpt.com/codex](https://chatgpt.com/codex).

<WorkflowSteps variant="headings">
1. Open Codex in your browser

    Go to [chatgpt.com/codex](https://chatgpt.com/codex). You can also delegate a task to Codex by tagging `@codex` in a GitHub pull request comment (requires signing in to ChatGPT).

2. Set up an environment

    Before starting your first task, set up an environment for Codex. Open the environment settings at [chatgpt.com/codex](https://chatgpt.com/codex/settings/environments) and follow the steps to connect a GitHub repository.

3. Launch a task and monitor progress

    Once your environment is ready, launch coding tasks from the [Codex interface](https://chatgpt.com/codex). You can monitor progress in real time by viewing logs, or let tasks run in the background.

    <ExampleGallery>
     </ExampleGallery>

4. Review changes and create a pull request

    When a task completes, review the proposed changes in the diff view. You can iterate on the results or create a pull request directly in your GitHub repository.

    Codex also provides a preview of the changes. You can accept the PR as is, or check out the branch locally to test the changes:

    ```bash
    git fetch
    git checkout <branch-name>
    ```

    </WorkflowSteps>

  </div>



<div class="h-6" aria-hidden="true"></div>

## Next steps

[

<span slot="icon">
      </span>
    Use the Codex app to work with your local projects.

](https://developers.openai.com/codex/app)

[

<span slot="icon">
      </span>
    Move supported instruction files, MCP server configuration, skills, and
    subagents into Codex.

](https://developers.openai.com/codex/migrate)

---

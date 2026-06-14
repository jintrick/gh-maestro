---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-copilot-upload-asset.md
original_title: test-copilot-upload-asset
fetched_at: 2026-06-14T00:40:11.212388+00:00
---

---
on:
  workflow_dispatch:
permissions:
  contents: read
engine: copilot
safe-outputs:
  upload-asset:
    max: 1
timeout-minutes: 5
---

# Test Copilot Upload Asset

Test the `upload_asset` safe output type with the Copilot engine.

## Task

Find the latest release in this repository and upload a small test asset to it.
Create a file named `test-asset.txt` with the content `Test asset uploaded by automated test workflow.`
Then upload it as an asset to the latest release.

Output results in JSONL format using the `upload_asset` tool.

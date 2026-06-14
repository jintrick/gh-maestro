---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-copilot-upload-artifact.md
original_title: test-copilot-upload-artifact
fetched_at: 2026-06-14T00:40:11.203412+00:00
---

---
on:
  workflow_dispatch:
permissions:
  contents: read
  actions: read
engine: copilot
safe-outputs:
  upload-artifact:
    max-uploads: 1
    allowed-paths:
      - "output/**"
---

# Test Copilot Upload Artifact

Test the `upload_artifact` safe output type with the Copilot engine.

## Task

Create a small text file at `output/result.txt` with the content "Hello from upload-artifact test" and upload it as a GitHub Actions artifact named "test-artifact".

Output results in JSONL format using the `upload_artifact` tool.

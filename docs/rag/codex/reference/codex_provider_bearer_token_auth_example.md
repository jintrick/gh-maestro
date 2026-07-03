---
source_url: https://developers.openai.com/codex/llms-full.txt
original_title: --- Example: command-backed bearer token auth ---
fetched_at: 2026-07-03T06:05:55.863Z
---

# --- Example: command-backed bearer token auth ---

# [model_providers.proxy]

# name = "OpenAI using LLM proxy"

# base_url = "https://proxy.example.com/v1"

# wire_api = "responses"

#

# [model_providers.proxy.auth]

# command = "/usr/local/bin/fetch-codex-token"

# args = ["--audience", "codex"]

# timeout_ms = 5000

# refresh_interval_ms = 300000

# --- Example: Local OSS (e.g., Ollama-compatible) ---

# [model_providers.local_ollama]

# name = "Ollama"

# base_url = "http://localhost:11434/v1"

# wire_api = "responses"

################################################################################

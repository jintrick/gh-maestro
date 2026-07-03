---
source_url: https://developers.openai.com/codex/llms-full.txt
original_title: --- Example: OpenAI data residency with explicit base URL or headers ---
fetched_at: 2026-07-03T06:05:55.863Z
---

# --- Example: OpenAI data residency with explicit base URL or headers ---

# [model_providers.openaidr]

# name = "OpenAI Data Residency"

# base_url = "https://us.api.openai.com/v1" # example with 'us' domain prefix

# wire_api = "responses" # only supported value

# # requires_openai_auth = true # use only for providers backed by OpenAI auth

# # request_max_retries = 4 # default 4; max 100

# # stream_max_retries = 5 # default 5; max 100

# # stream_idle_timeout_ms = 300000 # default 300_000 (5m)

# # supports_websockets = true # optional

# # experimental_bearer_token = "sk-example" # optional dev-only direct bearer token

# # http_headers = { "X-Example" = "value" }

# # env_http_headers = { "OpenAI-Organization" = "OPENAI_ORGANIZATION", "OpenAI-Project" = "OPENAI_PROJECT" }

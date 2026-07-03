---
source_url: https://developers.openai.com/codex/llms-full.txt
original_title: Core Model Selection
fetched_at: 2026-07-03T06:05:55.863Z
---

# Core Model Selection

################################################################################

# Primary model used by Codex. Recommended example for most users: "gpt-5.5".

model = "gpt-5.5"

# Communication style for supported models. Allowed values: none | friendly | pragmatic

# personality = "pragmatic"

# Optional model override for /review. Default: unset (uses current session model).

# review_model = "gpt-5.5"

# Provider id selected from [model_providers]. Default: "openai".

model_provider = "openai"

# Default OSS provider for --oss sessions. When unset, Codex prompts. Default: unset.

# oss_provider = "ollama"

# Preferred service tier. Built-in examples: fast | flex; model catalogs can add more.

# service_tier = "flex"

# Optional manual model metadata. When unset, Codex uses model or preset defaults.

# model_context_window = 128000 # tokens; default: auto for model

# model_auto_compact_token_limit = 64000 # tokens; unset uses model defaults

# tool_output_token_limit = 12000 # tokens stored per tool output

# model_catalog_json = "/absolute/path/to/models.json" # optional startup-only model catalog override

# background_terminal_max_timeout = 300000 # ms; max empty write_stdin poll window (default 5m)

# log_dir = "/absolute/path/to/codex-logs" # log directory; setting explicitly enables codex-tui.log; default: "$CODEX_HOME/log"

# sqlite_home = "/absolute/path/to/codex-state" # optional SQLite-backed runtime state directory

################################################################################

# Reasoning & Verbosity (Responses API capable models)

################################################################################

# Reasoning effort: minimal | low | medium | high | xhigh

# model_reasoning_effort = "medium"

# Optional override used when Codex runs in plan mode: none | minimal | low | medium | high | xhigh

# plan_mode_reasoning_effort = "high"

# Reasoning summary: auto | concise | detailed | none

# model_reasoning_summary = "auto"

# Text verbosity for GPT-5 family (Responses API): low | medium | high

# model_verbosity = "medium"

# Force enable or disable reasoning summaries for current model.

# model_supports_reasoning_summaries = true

################################################################################

---
source_url: https://developers.openai.com/codex/llms-full.txt
original_title: When to ask for command approval:
fetched_at: 2026-07-03T06:05:55.863Z
---

# When to ask for command approval:

# - untrusted: only known-safe read-only commands auto-run; others prompt

# - on-request: model decides when to ask (default)

# - never: never prompt (risky)

# - { granular = { ... } }: allow or auto-reject selected prompt categories

approval_policy = "on-request"

# Who reviews eligible approval prompts: user (default) | auto_review

# approvals_reviewer = "user"

---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/actions/setup/md/engine_rate_limit_429.md
original_title: engine_rate_limit_429
fetched_at: 2026-06-14T00:40:04.077147+00:00
---

> [!WARNING]
> **Engine Rate Limited (HTTP 429)**: The {engine_label} engine hit provider rate limits and could not complete this run.

This signal was detected from engine runtime logs/OTLP telemetry.

**What to do next**
- Retry the workflow after a short delay.
- If this keeps happening, reduce concurrent workflow volume or review provider quota/rate-limit policies.

---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-service-ports.md
original_title: test-service-ports
fetched_at: 2026-06-14T00:40:11.564972+00:00
---

---
on:
  workflow_dispatch:
permissions:
  contents: read
engine: copilot
services:
  postgres:
    image: postgres:15
    ports:
      - 5432:5432
  redis:
    image: redis:7
    ports:
      - 6379:6379
---

# Test Service Ports

This workflow tests that the compiler automatically generates `--allow-host-service-ports`
from `services:` port mappings.

Expected: the compiled lock file includes `--allow-host-service-ports` with expressions for
both PostgreSQL (port 5432) and Redis (port 6379).

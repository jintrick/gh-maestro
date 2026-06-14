---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/example-blocked-domains.md
original_title: example-blocked-domains
fetched_at: 2026-06-14T00:40:09.974802+00:00
---

---
engine: copilot
on:
  workflow_dispatch:
    
network:
  firewall: true
  allowed:
    - defaults
    - github
    - node
  blocked:
    - tracker.example.com
    - analytics.example.com
---

# Example: Blocked Domains

This workflow demonstrates using the `blocked` field in network configuration to block specific domains while allowing others.

The workflow allows access to:
- Basic infrastructure (`defaults`)
- GitHub domains (`github`)
- Node.js/NPM ecosystem (`node`)

But explicitly blocks:
- `tracker.example.com` (tracking domain)
- `analytics.example.com` (analytics domain)

Blocked domains take precedence over allowed domains, providing fine-grained control over network access.

---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/shared/jqschema.md
original_title: jqschema
fetched_at: 2026-06-14T00:40:11.773899+00:00
---

---
name: jqschema
description: JSON schema discovery utility that extracts structure and type information from JSON data
tools:
  bash:
    - "jq *"
    - "./.github/skills/jqschema/jqschema.sh"
    - "git"
---

## jqschema - JSON Schema Discovery

A utility script is available directly in the repository skill folder at `./.github/skills/jqschema/jqschema.sh` to help you discover the structure of complex JSON responses.

### Usage

```bash
cat data.json | ./.github/skills/jqschema/jqschema.sh
```

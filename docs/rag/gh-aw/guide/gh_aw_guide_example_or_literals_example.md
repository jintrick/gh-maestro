---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/cli/workflows/test-or-literals.md
original_title: test-or-literals
fetched_at: 2026-06-14T00:40:11.422354+00:00
---

---
description: Test OR expressions with string literals
on: workflow_dispatch
engine: copilot
---

# Test OR with String Literals

This workflow tests the new support for OR expressions with string literals in all quote types.

## Test Cases

### Test 1: Single Quotes
Repository fallback: ${{ inputs.repository || 'FStarLang/FStar' }}

### Test 2: Double Quotes
Name fallback: ${{ inputs.name || "default-name" }}

### Test 3: Backticks
Config fallback: ${{ inputs.config || `default-config` }}

### Test 4: Number Literal
Count fallback: ${{ inputs.count || 42 }}

### Test 5: Boolean Literal
Flag fallback: ${{ inputs.flag || true }}

### Test 6: Complex Expression
Complex: ${{ (inputs.value || 'default') && github.actor }}

Please verify that all expressions are parsed correctly and don't cause validation errors.

#!/usr/bin/env bash
# gh-maestro one-time global installer (Linux / macOS)
# Run once. Re-run to update after pulling new versions.
set -euo pipefail

node "$(dirname "$0")/scripts/gh-maestro-install.js"

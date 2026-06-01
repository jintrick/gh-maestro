#!/usr/bin/env bash
# gh-maestro one-time global installer (Linux / macOS)
# Run once. Re-run to update after pulling new versions.
set -euo pipefail

GH_MAESTRO_DIR="$(cd "$(dirname "$0")" && pwd)"

step() { printf '\033[36m[gh-maestro-install] %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32mv %s\033[0m\n' "$1"; }
fail() { printf '  \033[31mx %s\033[0m\n' "$1"; exit 1; }

# ─── Validate source ──────────────────────────────────────────────────────────

SKILLS_DIR="$GH_MAESTRO_DIR/skills"
[ -d "$SKILLS_DIR" ] || fail "skills/ directory not found in $GH_MAESTRO_DIR"

SETUP_SCRIPT="$GH_MAESTRO_DIR/scripts/gh-maestro-setup.js"
[ -f "$SETUP_SCRIPT" ] || fail "scripts/gh-maestro-setup.js not found in $GH_MAESTRO_DIR"

# ─── Install skills ───────────────────────────────────────────────────────────

step "Installing skills..."

SKILL_NAMES=("gh-maestro" "gh-maestro-orchestrator" "gh-maestro-base" "gh-maestro-coder" "gh-maestro-reviewer")

DESTINATIONS=(
  "$HOME/.claude/skills"
  "$HOME/.gemini/antigravity/skills"
)

for dest in "${DESTINATIONS[@]}"; do
  mkdir -p "$dest"
  for skill in "${SKILL_NAMES[@]}"; do
    src="$SKILLS_DIR/$skill"
    [ -d "$src" ] || fail "Skill folder not found: $src"
    dst_skill="$dest/$skill"
    mkdir -p "$dst_skill"
    cp -r "$src"/. "$dst_skill/"
    ok "$skill -> $dst_skill"
  done
done

# ─── Install shared scripts ───────────────────────────────────────────────────

step "Installing shared scripts..."

SCRIPT_DEST="$HOME/.gh-maestro/scripts"
mkdir -p "$SCRIPT_DEST"
cp "$SETUP_SCRIPT" "$SCRIPT_DEST/"
ok "gh-maestro-setup.js -> $SCRIPT_DEST"


# ─── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo "gh-maestro installed."
echo ""
echo "Usage:"
echo "  1. Open wezterm and navigate to your project root"
echo "  2. Start claude or agy"
echo "  3. Type: /gh-maestro"
echo ""

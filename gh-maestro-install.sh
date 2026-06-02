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

# ─── Install skills (Claude Code) ────────────────────────────────────────────

step "Installing skills for Claude Code..."

SKILL_NAMES=("gh-maestro" "gh-maestro-orchestrator" "gh-maestro-base" "gh-maestro-coder" "gh-maestro-reviewer")

CLAUDE_SKILLS_DEST="$HOME/.claude/skills"
mkdir -p "$CLAUDE_SKILLS_DEST"
for skill in "${SKILL_NAMES[@]}"; do
  src="$SKILLS_DIR/$skill"
  [ -d "$src" ] || fail "Skill folder not found: $src"
  dst_skill="$CLAUDE_SKILLS_DEST/$skill"
  mkdir -p "$dst_skill"
  cp -r "$src"/. "$dst_skill/"
  ok "$skill -> $dst_skill"
done

# ─── Install skills (agy / Antigravity) ──────────────────────────────────────

step "Installing skills for agy (Antigravity)..."

# agy はプラグイン構造が必要: ~/.gemini/config/plugins/<plugin>/skills/<skill>/
AGY_PLUGIN_DEST="$HOME/.gemini/config/plugins/gh-maestro"
mkdir -p "$AGY_PLUGIN_DEST"

# plugin.json マーカーファイルを作成
cat > "$AGY_PLUGIN_DEST/plugin.json" <<'JSON'
{
  "name": "gh-maestro",
  "version": "1.0.0",
  "description": "Multi-agent development orchestration system using GitHub as persistent store",
  "author": { "name": "gh-maestro" }
}
JSON
ok "plugin.json -> $AGY_PLUGIN_DEST"

AGY_SKILLS_DEST="$AGY_PLUGIN_DEST/skills"
mkdir -p "$AGY_SKILLS_DEST"
for skill in "${SKILL_NAMES[@]}"; do
  src="$SKILLS_DIR/$skill"
  [ -d "$src" ] || fail "Skill folder not found: $src"
  dst_skill="$AGY_SKILLS_DEST/$skill"
  mkdir -p "$dst_skill"
  cp -r "$src"/. "$dst_skill/"
  ok "$skill -> $dst_skill"
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

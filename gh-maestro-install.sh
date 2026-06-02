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

SKILL_NAMES=("gh-maestro" "gh-maestro-orchestrator" "gh-maestro-base" "gh-maestro-coder" "gh-maestro-reviewer")

# ─── Install skills ───────────────────────────────────────────────────────────
# 各スキルは skills/<skill>/<agent>/SKILL.md の構造を持つ
# scripts/ はスキルルートに置かれた共通アセット

install_skills() {
  local agent_dir="$1"
  local dest="$2"
  local agent_name="$3"

  step "Installing skills for $agent_name..."
  mkdir -p "$dest"

  for skill in "${SKILL_NAMES[@]}"; do
    skill_src="$SKILLS_DIR/$skill"
    [ -d "$skill_src" ] || fail "Skill folder not found: $skill_src"

    agent_skill_src="$skill_src/$agent_dir"
    [ -f "$agent_skill_src/SKILL.md" ] || continue  # このエージェント向けSKILL.mdがなければスキップ

    dst_skill="$dest/$skill"
    mkdir -p "$dst_skill"

    # エージェント別 SKILL.md をインストール
    cp "$agent_skill_src/SKILL.md" "$dst_skill/SKILL.md"

    # 共通スクリプトをインストール（存在する場合）
    if [ -d "$skill_src/scripts" ]; then
      mkdir -p "$dst_skill/scripts"
      cp -r "$skill_src/scripts/". "$dst_skill/scripts/"
    fi

    ok "$skill ($agent_dir) -> $dst_skill"
  done
}

install_skills "claude" "$HOME/.claude/skills" "Claude Code"
install_skills "agy" "$HOME/.gemini/antigravity-cli/skills" "agy (Antigravity)"

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

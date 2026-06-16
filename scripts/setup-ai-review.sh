#!/usr/bin/env bash
# ターゲットリポジトリにAIコードレビューCIをセットアップする
# Usage: ./scripts/setup-ai-review.sh <owner/repo>

set -euo pipefail

REPO="${1:-}"
if [[ -z "$REPO" ]]; then
  echo "Usage: $0 <owner/repo>" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE_FILE="$SCRIPT_DIR/../workflows/caller-template/ai-review.yml"

step() { echo "[setup-ai-review] $*"; }
ok()   { echo "  v $*"; }
fail() { echo "  x $*" >&2; exit 1; }

# ─── 1. 前提チェック ───────────────────────────────────────────────────────────

step "Checking prerequisites..."

command -v gh >/dev/null 2>&1 || fail "gh CLI not found in PATH."
gh auth status >/dev/null 2>&1 || fail "gh CLI not authenticated. Run 'gh auth login' first."
ok "gh CLI authenticated"

[[ -f "$TEMPLATE_FILE" ]] || fail "Template not found: $TEMPLATE_FILE"

# ─── 2. ai-review.yml を配置 ─────────────────────────────────────────────────

step "Deploying ai-review.yml to $REPO ..."

CONTENT_B64="$(base64 < "$TEMPLATE_FILE" | tr -d '\n')"
TARGET_PATH=".github/workflows/ai-review.yml"

EXISTING=$(gh api "repos/$REPO/contents/$TARGET_PATH" 2>/dev/null || true)
if [[ -n "$EXISTING" ]]; then
  EXISTING_SHA=$(echo "$EXISTING" | grep '"sha"' | head -1 | sed 's/.*"sha": "\(.*\)".*/\1/')
  BODY=$(printf '{"message":"ci: add AI code review workflow","content":"%s","sha":"%s"}' "$CONTENT_B64" "$EXISTING_SHA")
  step "File exists, updating..."
else
  BODY=$(printf '{"message":"ci: add AI code review workflow","content":"%s"}' "$CONTENT_B64")
  step "Creating new file..."
fi

echo "$BODY" | gh api "repos/$REPO/contents/$TARGET_PATH" --method PUT --input - >/dev/null
ok "ai-review.yml deployed"

# ─── 3. DEEPSEEK_API_KEY チェック＆設定 ──────────────────────────────────────

step "Checking DEEPSEEK_API_KEY secret..."

if gh secret list --repo "$REPO" 2>/dev/null | grep -q "DEEPSEEK_API_KEY"; then
  ok "DEEPSEEK_API_KEY already set — skipping"
else
  step "DEEPSEEK_API_KEY is not set. Please paste your API key:"
  gh secret set DEEPSEEK_API_KEY --repo "$REPO"
  ok "DEEPSEEK_API_KEY set"
fi

# ─── 4. 完了 ─────────────────────────────────────────────────────────────────

echo ""
echo "AI Code Review CI is ready on $REPO"
echo "Next PRs will trigger correctness / maintainability / resilience review."
echo ""

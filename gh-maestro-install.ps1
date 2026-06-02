#Requires -Version 5.1
<#
.SYNOPSIS
    gh-maestro one-time global installer
.DESCRIPTION
    Installs gh-maestro skills and setup scripts globally so that any project
    can start a session with /gh-maestro from claude or agy (inside wezterm).

    Run once. Re-run to update after pulling new versions.
#>

$ErrorActionPreference = "Stop"
$GhMaestroDir = $PSScriptRoot

function Write-Step { param([string]$Msg) Write-Host "[gh-maestro-install] $Msg" -ForegroundColor Cyan }
function Write-OK   { param([string]$Msg) Write-Host "  v $Msg" -ForegroundColor Green }
function Write-Fail { param([string]$Msg) Write-Host "  x $Msg" -ForegroundColor Red; exit 1 }

# ─── Validate source ──────────────────────────────────────────────────────────

$skillsDir = Join-Path $GhMaestroDir "skills"
if (-not (Test-Path $skillsDir)) {
    Write-Fail "skills/ directory not found in $GhMaestroDir"
}

$setupScript = Join-Path $GhMaestroDir "scripts\gh-maestro-setup.js"
if (-not (Test-Path $setupScript)) {
    Write-Fail "scripts\gh-maestro-setup.js not found in $GhMaestroDir"
}

$skillNames = @("gh-maestro", "gh-maestro-orchestrator", "gh-maestro-base", "gh-maestro-coder", "gh-maestro-reviewer")

# ─── Install skills ───────────────────────────────────────────────────────────
# 各スキルは skills/<skill>/<agent>/SKILL.md の構造を持つ
# scripts/ はスキルルートに置かれた共通アセット

$agents = @(
    @{ Name = "Claude Code"; AgentDir = "claude"; Dest = "$env:USERPROFILE\.claude\skills" }
    @{ Name = "agy (Antigravity)"; AgentDir = "agy"; Dest = "$env:USERPROFILE\.gemini\antigravity-cli\skills" }
)

foreach ($agent in $agents) {
    Write-Step "Installing skills for $($agent.Name)..."
    $null = New-Item -ItemType Directory -Force $agent.Dest

    foreach ($skill in $skillNames) {
        $skillSrc = Join-Path $skillsDir $skill
        if (-not (Test-Path $skillSrc)) { Write-Fail "Skill folder not found: $skillSrc" }

        $agentSkillSrc = Join-Path $skillSrc $agent.AgentDir
        if (-not (Test-Path (Join-Path $agentSkillSrc "SKILL.md"))) {
            continue  # このエージェント向けSKILL.mdがなければスキップ
        }

        $dstSkill = Join-Path $agent.Dest $skill
        $null = New-Item -ItemType Directory -Force $dstSkill

        # エージェント別 SKILL.md をインストール
        Copy-Item (Join-Path $agentSkillSrc "SKILL.md") $dstSkill -Force

        # 共通スクリプトをインストール（存在する場合）
        $scriptsSrc = Join-Path $skillSrc "scripts"
        if ($scriptsSrc -and (Test-Path $scriptsSrc)) {
            $scriptsDst = Join-Path $dstSkill "scripts"
            $null = New-Item -ItemType Directory -Force $scriptsDst
            Copy-Item "$scriptsSrc\*" $scriptsDst -Recurse -Force
        }

        Write-OK "$skill ($($agent.AgentDir)) -> $dstSkill"
    }
}

# ─── Install shared scripts ───────────────────────────────────────────────────

Write-Step "Installing shared scripts..."

$scriptDest = "$env:USERPROFILE\.gh-maestro\scripts"
$null = New-Item -ItemType Directory -Force $scriptDest
Copy-Item $setupScript $scriptDest -Force
Write-OK "gh-maestro-setup.js -> $scriptDest"


# ─── Done ─────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "gh-maestro installed." -ForegroundColor Green
Write-Host ""
Write-Host "Usage:"
Write-Host "  1. Open wezterm and navigate to your project root"
Write-Host "  2. Start claude or agy"
Write-Host "  3. Type: /gh-maestro"
Write-Host ""

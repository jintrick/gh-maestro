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

# ─── Install skills ───────────────────────────────────────────────────────────

Write-Step "Installing skills..."

$skillNames = @("gh-maestro", "gh-maestro-orchestrator", "gh-maestro-base", "gh-maestro-coder", "gh-maestro-reviewer")

$destinations = @(
    "$env:USERPROFILE\.claude\skills"
    "$env:USERPROFILE\.gemini\antigravity\skills"
)

foreach ($dest in $destinations) {
    $null = New-Item -ItemType Directory -Force $dest
    foreach ($skill in $skillNames) {
        $src = Join-Path $skillsDir $skill
        if (-not (Test-Path $src)) {
            Write-Fail "Skill folder not found: $src"
        }
        $dstSkill = Join-Path $dest $skill
        $null = New-Item -ItemType Directory -Force $dstSkill
        Copy-Item "$src\*" $dstSkill -Recurse -Force
        Write-OK "$skill -> $dstSkill"
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

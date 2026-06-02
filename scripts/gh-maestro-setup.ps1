#Requires -Version 5.1
<#
.SYNOPSIS
    gh-maestro per-project setup script
.DESCRIPTION
    Called by the /gh-maestro skill. Validates prerequisites, creates wezterm panes,
    starts coder/reviewer agents, and writes .gh-maestro/session.json.

    Must be run from inside a wezterm pane (WEZTERM_PANE must be set).
    The caller (orchestrator agent) reads session.json to obtain pane-ids.
.PARAMETER WorkspaceRoot
    Path to the target project root. Defaults to the current directory.
#>
param(
    [string]$WorkspaceRoot = (Get-Location).Path
)

$ErrorActionPreference = "Stop"

function Write-Step { param([string]$Msg) Write-Host "[gh-maestro] $Msg" -ForegroundColor Cyan }
function Write-OK   { param([string]$Msg) Write-Host "  v $Msg" -ForegroundColor Green }
function Write-Fail { param([string]$Msg) Write-Host "  x $Msg" -ForegroundColor Red; exit 1 }

# ─── 1. Prerequisites ─────────────────────────────────────────────────────────

Write-Step "Checking prerequisites..."

if (-not $env:WEZTERM_PANE) {
    Write-Fail "WEZTERM_PANE is not set. Run this from inside a wezterm pane."
}

if (-not (Get-Command wezterm -ErrorAction SilentlyContinue)) {
    Write-Fail "wezterm CLI not found in PATH."
}

if (-not (Test-Path (Join-Path $WorkspaceRoot ".git"))) {
    Write-Fail "Not a git repository: $WorkspaceRoot"
}

$remoteUrl = git -C $WorkspaceRoot config --get remote.origin.url 2>&1
if ($LASTEXITCODE -ne 0 -or -not $remoteUrl) {
    Write-Fail "No remote 'origin' found. Configure git remote first."
}
if ($remoteUrl -match 'github\.com[:/](.+?/.+?)(\.git)?$') {
    $OwnerRepo = $Matches[1]
} else {
    Write-Fail "Cannot parse owner/repo from remote URL: $remoteUrl"
}
Write-OK "Repository: $OwnerRepo"

$ghCheck = gh auth status 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Fail "gh CLI not authenticated. Run 'gh auth login' first."
}
Write-OK "gh CLI authenticated"

$devBranch = git -C $WorkspaceRoot branch --list dev
if (-not $devBranch) {
    Write-Step "Creating 'dev' branch from main..."
    git -C $WorkspaceRoot checkout -b dev main 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Fail "Failed to create 'dev' branch." }
    git -C $WorkspaceRoot push -u origin dev 2>&1 | Out-Null
}
Write-OK "Branch 'dev' exists"

# ─── 2. Get orchestrator pane-id ─────────────────────────────────────────────

$orchestratorPaneId = $env:WEZTERM_PANE
Write-OK "Orchestrator pane-id: $orchestratorPaneId"

# ─── 3. Create coder and reviewer panes ──────────────────────────────────────

Write-Step "Creating coder pane..."
$coderPaneId = (wezterm cli split-pane --bottom 2>&1)
if ($LASTEXITCODE -ne 0 -or -not $coderPaneId) {
    Write-Fail "Failed to create coder pane: $coderPaneId"
}
$coderPaneId = $coderPaneId.Trim()
Write-OK "Coder pane-id: $coderPaneId"

Write-Step "Creating reviewer pane..."
$reviewerPaneId = (wezterm cli split-pane --bottom 2>&1)
if ($LASTEXITCODE -ne 0 -or -not $reviewerPaneId) {
    Write-Fail "Failed to create reviewer pane: $reviewerPaneId"
}
$reviewerPaneId = $reviewerPaneId.Trim()
Write-OK "Reviewer pane-id: $reviewerPaneId"

# ─── 4. Write session.json ────────────────────────────────────────────────────

$sessionDir = Join-Path $WorkspaceRoot ".gh-maestro"
$null = New-Item -ItemType Directory -Force $sessionDir
$session = [ordered]@{
    repo                = $OwnerRepo
    orchestratorPaneId  = $orchestratorPaneId
    coderPaneId         = $coderPaneId
    reviewerPaneId      = $reviewerPaneId
    startedAt           = (Get-Date -Format "o")
}
$sessionPath = Join-Path $sessionDir "session.json"
$session | ConvertTo-Json | Set-Content $sessionPath -Encoding UTF8
Write-OK ".gh-maestro/session.json written"

# ─── 5. Start worker agents ───────────────────────────────────────────────────

function Send-To {
    param([string]$PaneId, [string]$Text)
    wezterm cli send-text --pane-id $PaneId $Text
    wezterm cli send-text --pane-id $PaneId --no-paste "`r"
}

Write-Step "Setting working directories..."
Send-To -PaneId $coderPaneId    -Text "cd `"$WorkspaceRoot`""
Send-To -PaneId $reviewerPaneId -Text "cd `"$WorkspaceRoot`""
Start-Sleep -Milliseconds 600

Write-Step "Starting coder (agy)..."
Send-To -PaneId $coderPaneId -Text "agy"
Start-Sleep -Milliseconds 3000
$coderInit = "リポジトリ: $OwnerRepo / ORCHESTRATOR_PANE_ID=$orchestratorPaneId / gh-maestro-coderスキルに従って動作してください。準備完了後、待機してください。"
Send-To -PaneId $coderPaneId -Text $coderInit

Write-Step "Starting reviewer (agy)..."
Send-To -PaneId $reviewerPaneId -Text "agy"
Start-Sleep -Milliseconds 3000
$reviewerInit = "リポジトリ: $OwnerRepo / ORCHESTRATOR_PANE_ID=$orchestratorPaneId / gh-maestro-reviewerスキルに従って動作してください。準備完了後、待機してください。"
Send-To -PaneId $reviewerPaneId -Text $reviewerInit

# ─── 6. Output session info ───────────────────────────────────────────────────

Write-Host ""
Write-Host "gh-maestro session started." -ForegroundColor Green
Write-Host ""
Write-Host "  Repository        : $OwnerRepo"
Write-Host "  Orchestrator pane : $orchestratorPaneId"
Write-Host "  Coder pane        : $coderPaneId"
Write-Host "  Reviewer pane     : $reviewerPaneId"
Write-Host ""
Write-Host "session.json: $sessionPath"
Write-Host ""

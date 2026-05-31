#Requires -Version 5.1
<#
.SYNOPSIS
    gh-maestro startup script for Windows / wmux
.DESCRIPTION
    1. Validates prerequisites
    2. Installs skills into the workspace
    3. Configures agy MCP (wmux)
    4. Discovers or creates wmux panes
    5. Starts coder/reviewer (agy) and orchestrator (claude)
.NOTES
    Must be run from within a wmux pane.
    The workspace must have at least 3 panes, or this script will attempt to split.
#>

$ErrorActionPreference = "Stop"
$WorkspaceRoot = (Get-Location).Path
$GhMaestroDir = $PSScriptRoot

# ─── helpers ──────────────────────────────────────────────────────────────────

function Write-Step { param([string]$Msg) Write-Host "[gh-maestro] $Msg" -ForegroundColor Cyan }
function Write-OK   { param([string]$Msg) Write-Host "  ✓ $Msg" -ForegroundColor Green }
function Write-Fail { param([string]$Msg) Write-Host "  ✗ $Msg" -ForegroundColor Red; exit 1 }

# ─── 1. Prerequisites ─────────────────────────────────────────────────────────

Write-Step "Checking prerequisites..."

if (-not (Test-Path (Join-Path $WorkspaceRoot ".git"))) {
    Write-Fail "Not a git repository. Run gh-maestro.bat from your project's workspace root."
}

$remoteUrl = git config --get remote.origin.url 2>&1
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

$devBranch = git branch --list dev
if (-not $devBranch) {
    Write-Step "Creating 'dev' branch from main..."
    git checkout -b dev main 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Fail "Failed to create 'dev' branch." }
    git push -u origin dev 2>&1 | Out-Null
}
Write-OK "Branch 'dev' exists"

# ─── 2. Install skills ────────────────────────────────────────────────────────

Write-Step "Installing skills..."

@(
    @{ Src = "gh-maestro-orchestrator"; Dst = ".claude\skills\gh-maestro-orchestrator" }
    @{ Src = "gh-maestro-coder";        Dst = ".agents\skills\gh-maestro-coder" }
    @{ Src = "gh-maestro-reviewer";     Dst = ".agents\skills\gh-maestro-reviewer" }
) | ForEach-Object {
    $src = Join-Path $GhMaestroDir "skills\$($_.Src)\SKILL.md"
    $dst = Join-Path $WorkspaceRoot "$($_.Dst)\SKILL.md"
    $null = New-Item -ItemType Directory -Force (Split-Path $dst)
    Copy-Item $src $dst -Force
    Write-OK "$($_.Src) → $($_.Dst)"
}

# ─── 3. Configure agy MCP (wmux) ─────────────────────────────────────────────

Write-Step "Configuring agy MCP..."
$agentDir = Join-Path $WorkspaceRoot ".agents"
$null = New-Item -ItemType Directory -Force $agentDir
$mcpPath = Join-Path $agentDir "mcp_config.json"
$wmuxEntry = [pscustomobject]@{ command = "wmux"; args = @("mcp") }

if (Test-Path $mcpPath) {
    $cfg = Get-Content $mcpPath -Raw | ConvertFrom-Json
    if (-not $cfg.PSObject.Properties["mcpServers"]) {
        $cfg | Add-Member -NotePropertyName "mcpServers" -NotePropertyValue ([pscustomobject]@{})
    }
    $cfg.mcpServers | Add-Member -NotePropertyName "wmux" -NotePropertyValue $wmuxEntry -Force
    $cfg | ConvertTo-Json -Depth 10 | Set-Content $mcpPath -Encoding UTF8
} else {
    [pscustomobject]@{ mcpServers = [pscustomobject]@{ wmux = $wmuxEntry } } |
        ConvertTo-Json -Depth 10 | Set-Content $mcpPath -Encoding UTF8
}
Write-OK "mcp_config.json updated"

# ─── 4. Connect to wmux Named Pipe ───────────────────────────────────────────

Write-Step "Connecting to wmux..."
$tokenFile = Join-Path $env:APPDATA "wmux\pipe-token"
if (-not (Test-Path $tokenFile)) {
    Write-Fail "wmux pipe-token not found at $tokenFile. Is wmux running?"
}
$token = (Get-Content $tokenFile -Raw).Trim()
$pipeName = "wmux-rpc-$token"
$tokenB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($token))

$pipe = $null
try {
    $pipe = [System.IO.Pipes.NamedPipeClientStream]::new(
        ".", $pipeName,
        [System.IO.Pipes.PipeDirection]::InOut,
        [System.IO.Pipes.PipeOptions]::None)
    $pipe.Connect(5000)
} catch {
    Write-Fail "Cannot connect to wmux pipe: $_"
}

$writer = [System.IO.StreamWriter]::new($pipe); $writer.AutoFlush = $true
$reader = [System.IO.StreamReader]::new($pipe)
$rpcId  = 0

function Invoke-Rpc {
    param([string]$Method, [hashtable]$Params = @{}, [bool]$WithToken = $false)
    $script:rpcId++
    $req = [ordered]@{ jsonrpc = "2.0"; id = $script:rpcId; method = $Method; params = $Params }
    if ($WithToken) { $req.token = $tokenB64 }
    $writer.WriteLine(($req | ConvertTo-Json -Depth 10 -Compress))
    $line = $reader.ReadLine()
    $resp = $line | ConvertFrom-Json
    if ($resp.error) { throw "RPC $Method → $($resp.error | ConvertTo-Json -Compress)" }
    return $resp.result
}

# Authenticate
Invoke-Rpc -Method "system.identify" -Params @{} -WithToken $true | Out-Null
Write-OK "wmux connected"

# ─── 5. Discover / create panes ──────────────────────────────────────────────

Write-Step "Discovering panes..."

function Get-Surfaces { return Invoke-Rpc -Method "surface.list" -Params @{} }

$surfaces = Get-Surfaces

# If fewer than 3 surfaces, try splitting
if ($surfaces.Count -lt 3) {
    Write-Step "Need 3 panes (found $($surfaces.Count)). Splitting..."
    $needed = 3 - $surfaces.Count
    for ($i = 0; $i -lt $needed; $i++) {
        try {
            Invoke-Rpc -Method "pane.split" -Params @{ direction = "horizontal" } | Out-Null
            Start-Sleep -Milliseconds 800
        } catch {
            Write-Fail "pane.split failed: $_`n`nPlease manually create 3 panes in wmux before running gh-maestro.bat."
        }
    }
    $surfaces = Get-Surfaces
}

if ($surfaces.Count -lt 3) {
    Write-Fail "Still fewer than 3 panes after split attempt. Please manually create 3 panes in wmux."
}

# Active surface = orchestrator; others = coder, reviewer
$active  = @($surfaces | Where-Object { $_.isActive -eq $true })[0]
$workers = @($surfaces | Where-Object { $_.isActive -ne $true })

$orchestratorPtyId = $active.ptyId
$orchestratorPaneId = $active.paneId
$coderPtyId        = $workers[0].ptyId
$coderPaneId       = $workers[0].paneId
$reviewerPtyId     = $workers[1].ptyId
$reviewerPaneId    = $workers[1].paneId

Write-OK "orchestrator pty: $orchestratorPtyId"
Write-OK "coder       pty: $coderPtyId"
Write-OK "reviewer    pty: $reviewerPtyId"

# ─── 6. Write session file (agents read this for PTY IDs) ────────────────────

$sessionDir = Join-Path $WorkspaceRoot ".gh-maestro"
$null = New-Item -ItemType Directory -Force $sessionDir
$session = [ordered]@{
    repo              = $OwnerRepo
    orchestratorPtyId = $orchestratorPtyId
    coderPtyId        = $coderPtyId
    reviewerPtyId     = $reviewerPtyId
    startedAt         = (Get-Date -Format "o")
}
$session | ConvertTo-Json | Set-Content (Join-Path $sessionDir "session.json") -Encoding UTF8
Write-OK ".gh-maestro/session.json written"

# ─── 7. Helper: send text + Enter to a pane ──────────────────────────────────

function Send-To {
    param([string]$PaneId, [string]$Text, [switch]$NoEnter)
    Invoke-Rpc -Method "input.send" -Params @{ text = $Text; paneId = $PaneId } | Out-Null
    if (-not $NoEnter) {
        Start-Sleep -Milliseconds 80
        Invoke-Rpc -Method "input.sendKey" -Params @{ key = "enter"; paneId = $PaneId } | Out-Null
    }
}

# ─── 8. Set working directory for worker panes ───────────────────────────────

Write-Step "Setting working directories..."
Send-To -PaneId $coderPaneId    -Text "cd `"$WorkspaceRoot`""
Send-To -PaneId $reviewerPaneId -Text "cd `"$WorkspaceRoot`""
Start-Sleep -Milliseconds 600

# ─── 9. Start agy agents ─────────────────────────────────────────────────────

Write-Step "Starting coder (agy)..."
Send-To -PaneId $coderPaneId -Text "agy"
Start-Sleep -Milliseconds 3000
$coderInit = "リポジトリ: $OwnerRepo / ORCHESTRATOR_PTY_ID=$orchestratorPtyId / gh-maestro-coderスキルに従って動作してください。準備完了後、待機してください。"
Send-To -PaneId $coderPaneId -Text $coderInit

Write-Step "Starting reviewer (agy)..."
Send-To -PaneId $reviewerPaneId -Text "agy"
Start-Sleep -Milliseconds 3000
$reviewerInit = "リポジトリ: $OwnerRepo / ORCHESTRATOR_PTY_ID=$orchestratorPtyId / gh-maestro-reviewerスキルに従って動作してください。準備完了後、待機してください。"
Send-To -PaneId $reviewerPaneId -Text $reviewerInit

$pipe.Dispose()

# ─── 10. Start orchestrator (claude) in current pane ─────────────────────────

Write-Step "Starting orchestrator (claude)..."
Write-Host ""
Write-Host "  Repository : $OwnerRepo"
Write-Host "  Coder PTY  : $coderPtyId"
Write-Host "  Reviewer   : $reviewerPtyId"
Write-Host ""

# claude auto-loads .claude/skills/gh-maestro-orchestrator/SKILL.md
# session.json is read by the skill via dynamic injection
& claude

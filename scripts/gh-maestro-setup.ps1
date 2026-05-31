#Requires -Version 5.1
<#
.SYNOPSIS
    gh-maestro per-project setup script
.DESCRIPTION
    Called by the /gh-maestro skill. Validates prerequisites, creates wmux panes,
    starts coder/reviewer agents, and writes .gh-maestro/session.json.

    The caller (orchestrator agent) reads session.json to obtain PTY IDs.
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

# ─── 2. Connect to wmux Named Pipe ───────────────────────────────────────────

Write-Step "Connecting to wmux..."
$tokenFile = Join-Path $env:APPDATA "wmux\pipe-token"
if (-not (Test-Path $tokenFile)) {
    Write-Fail "wmux pipe-token not found at $tokenFile. Is wmux running inside a pane?"
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
    Write-Fail "Cannot connect to wmux pipe '$pipeName': $_"
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
    if ($resp.error) { throw "RPC $Method failed: $($resp.error | ConvertTo-Json -Compress)" }
    return $resp.result
}

Invoke-Rpc -Method "system.identify" -Params @{} -WithToken $true | Out-Null
Write-OK "wmux connected"

# ─── 3. Discover / create panes ──────────────────────────────────────────────

Write-Step "Discovering panes..."

function Get-Surfaces { return Invoke-Rpc -Method "surface.list" -Params @{} }

$surfaces = Get-Surfaces

if ($surfaces.Count -lt 3) {
    Write-Step "Need 3 panes (found $($surfaces.Count)). Splitting..."
    $needed = 3 - $surfaces.Count
    for ($i = 0; $i -lt $needed; $i++) {
        try {
            Invoke-Rpc -Method "pane.split" -Params @{ direction = "horizontal" } | Out-Null
            Start-Sleep -Milliseconds 800
        } catch {
            Write-Fail "pane.split failed: $_`nPlease manually create 3 panes in wmux and retry."
        }
    }
    $surfaces = Get-Surfaces
}

if ($surfaces.Count -lt 3) {
    Write-Fail "Still fewer than 3 panes. Please manually create 3 panes in wmux."
}

$active  = @($surfaces | Where-Object { $_.isActive -eq $true })[0]
$workers = @($surfaces | Where-Object { $_.isActive -ne $true })

$orchestratorPtyId  = $active.ptyId
$orchestratorPaneId = $active.paneId
$coderPtyId         = $workers[0].ptyId
$coderPaneId        = $workers[0].paneId
$reviewerPtyId      = $workers[1].ptyId
$reviewerPaneId     = $workers[1].paneId

Write-OK "orchestrator pty: $orchestratorPtyId"
Write-OK "coder       pty: $coderPtyId"
Write-OK "reviewer    pty: $reviewerPtyId"

# ─── 4. Write session.json ────────────────────────────────────────────────────

$sessionDir = Join-Path $WorkspaceRoot ".gh-maestro"
$null = New-Item -ItemType Directory -Force $sessionDir
$session = [ordered]@{
    repo              = $OwnerRepo
    orchestratorPtyId = $orchestratorPtyId
    coderPtyId        = $coderPtyId
    reviewerPtyId     = $reviewerPtyId
    startedAt         = (Get-Date -Format "o")
}
$sessionPath = Join-Path $sessionDir "session.json"
$session | ConvertTo-Json | Set-Content $sessionPath -Encoding UTF8
Write-OK ".gh-maestro/session.json written"

# ─── 5. Start worker agents ───────────────────────────────────────────────────

function Send-To {
    param([string]$PaneId, [string]$Text, [switch]$NoEnter)
    Invoke-Rpc -Method "input.send" -Params @{ text = $Text; paneId = $PaneId } | Out-Null
    if (-not $NoEnter) {
        Start-Sleep -Milliseconds 80
        Invoke-Rpc -Method "input.sendKey" -Params @{ key = "enter"; paneId = $PaneId } | Out-Null
    }
}

Write-Step "Setting working directories..."
Send-To -PaneId $coderPaneId    -Text "cd `"$WorkspaceRoot`""
Send-To -PaneId $reviewerPaneId -Text "cd `"$WorkspaceRoot`""
Start-Sleep -Milliseconds 600

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

# ─── 6. Output session info ───────────────────────────────────────────────────

Write-Host ""
Write-Host "gh-maestro session started." -ForegroundColor Green
Write-Host ""
Write-Host "  Repository : $OwnerRepo"
Write-Host "  Orchestrator PTY : $orchestratorPtyId"
Write-Host "  Coder PTY        : $coderPtyId"
Write-Host "  Reviewer PTY     : $reviewerPtyId"
Write-Host ""
Write-Host "session.json: $sessionPath"
Write-Host ""

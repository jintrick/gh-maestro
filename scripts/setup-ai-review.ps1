#Requires -Version 5.1
<#
.SYNOPSIS
    ターゲットリポジトリにAIコードレビューCIをセットアップする
.DESCRIPTION
    1. .github/workflows/ai-review.yml をターゲットリポジトリに配置する
    2. DEEPSEEK_API_KEY が未設定なら gh secret set を実行する
.PARAMETER Repo
    ターゲットリポジトリ (例: jintrick/my-project)
#>
param(
    [Parameter(Mandatory)]
    [string]$Repo
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path $MyInvocation.MyCommand.Path
$TemplateFile = Join-Path $ScriptDir "..\workflows\caller-template\ai-review.yml"

function Write-Step { param([string]$Msg) Write-Host "[setup-ai-review] $Msg" -ForegroundColor Cyan }
function Write-OK   { param([string]$Msg) Write-Host "  v $Msg" -ForegroundColor Green }
function Write-Fail { param([string]$Msg) Write-Host "  x $Msg" -ForegroundColor Red; exit 1 }

# ─── 1. 前提チェック ───────────────────────────────────────────────────────────

Write-Step "Checking prerequisites..."

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Write-Fail "gh CLI not found in PATH."
}
gh auth status 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Fail "gh CLI not authenticated. Run 'gh auth login' first." }
Write-OK "gh CLI authenticated"

if (-not (Test-Path $TemplateFile)) {
    Write-Fail "Template not found: $TemplateFile"
}

# ─── 2. ai-review.yml を配置 ─────────────────────────────────────────────────

Write-Step "Deploying ai-review.yml to $Repo ..."

$content = Get-Content $TemplateFile -Raw -Encoding UTF8
$contentB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($content))

$targetPath = ".github/workflows/ai-review.yml"

# 既存ファイルのSHAを取得（更新時に必要）
$existing = gh api "repos/$Repo/contents/$targetPath" 2>&1
if ($LASTEXITCODE -eq 0) {
    $existingSha = ($existing | ConvertFrom-Json).sha
    $body = @{ message = "ci: add AI code review workflow"; content = $contentB64; sha = $existingSha } | ConvertTo-Json
    Write-Step "File exists, updating..."
} else {
    $body = @{ message = "ci: add AI code review workflow"; content = $contentB64 } | ConvertTo-Json
    Write-Step "Creating new file..."
}

$body | gh api "repos/$Repo/contents/$targetPath" --method PUT --input - | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Fail "Failed to deploy ai-review.yml" }
Write-OK "ai-review.yml deployed"

# ─── 3. DEEPSEEK_API_KEY チェック＆設定 ──────────────────────────────────────

Write-Step "Checking DEEPSEEK_API_KEY secret..."

$secrets = gh secret list --repo $Repo 2>&1
$hasKey = ($secrets | Select-String "DEEPSEEK_API_KEY") -ne $null

if ($hasKey) {
    Write-OK "DEEPSEEK_API_KEY already set — skipping"
} else {
    Write-Step "DEEPSEEK_API_KEY is not set. Please paste your API key:"
    gh secret set DEEPSEEK_API_KEY --repo $Repo
    if ($LASTEXITCODE -ne 0) { Write-Fail "Failed to set DEEPSEEK_API_KEY" }
    Write-OK "DEEPSEEK_API_KEY set"
}

# ─── 4. 完了 ─────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "AI Code Review CI is ready on $Repo" -ForegroundColor Green
Write-Host "Next PRs will trigger correctness / maintainability / resilience review."
Write-Host ""

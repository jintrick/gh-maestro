function gemini_pw7 {
    $env:GEMINI_SYSTEM_MD = 1
    $env:ComSpec = "pwsh.exe"
    gemini @args
}

function claude-ds {
    # reasonix が平文保存している .env から DeepSeek キーを取得する。
    # reasonix はプロセス環境変数を受け付けず .env が必須のため、同じキーが既に平文で
    # ディスク上に存在する。SecretStore/gpg で守る意味が消えたので .env を単一の源にする。
    $envFile = Join-Path $env:APPDATA "reasonix\.env"
    $line = Get-Content $envFile -ErrorAction SilentlyContinue |
            Where-Object { $_ -match '^DEEPSEEK_API_KEY=' } | Select-Object -First 1
    $apiKey = if ($line) { ($line -replace '^DEEPSEEK_API_KEY=', '').Trim() } else { $null }

    if (-not $apiKey) {
        Write-Warning "DEEPSEEK_API_KEY が $envFile に見つかりません。"
        return
    }

    $env:ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic"
    $env:ANTHROPIC_AUTH_TOKEN = $apiKey
    $env:ANTHROPIC_MODEL = "deepseek-v4-flash"
    $env:ANTHROPIC_DEFAULT_OPUS_MODEL = "deepseek-v4-pro[1m]"
    $env:ANTHROPIC_DEFAULT_SONNET_MODEL = "deepseek-v4-flash"
    $env:ANTHROPIC_DEFAULT_HAIKU_MODEL = "deepseek-v4-flash"
    $env:CLAUDE_CODE_SUBAGENT_MODEL = "deepseek-v4-flash"

    claude @args
}

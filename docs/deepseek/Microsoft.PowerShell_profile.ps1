function claude-ds {
    # SecretStoreからキーを安全に取得
    $apiKey = Get-Secret -Name "DeepSeekAPIKey" -AsPlainText

    if (-not $apiKey) {
        Write-Warning "APIキーを取得しなおしたうえ、Set-Secret -Name 'DeepSeekAPIKey' で設定をやり直してください。"
        return
    }

    $env:ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic"
    $env:ANTHROPIC_AUTH_TOKEN = $apiKey
    $env:ANTHROPIC_MODEL = "deepseek-v4-pro[1m]"
    $env:ANTHROPIC_DEFAULT_OPUS_MODEL = "deepseek-v4-pro[1m]"
    $env:ANTHROPIC_DEFAULT_SONNET_MODEL = "deepseek-v4-pro[1m]"
    $env:ANTHROPIC_DEFAULT_HAIKU_MODEL = "deepseek-v4-flash"
    $env:CLAUDE_CODE_SUBAGENT_MODEL = "deepseek-v4-flash"
    $env:CLAUDE_CODE_EFFORT_LEVEL = "max"

    claude @args
}
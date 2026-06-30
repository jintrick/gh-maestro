# DeepSeek版 Claude Code
# キーは reasonix が平文保存する ~/.reasonix/.env から取得する。
# reasonix はプロセス環境変数を受け付けず .env が必須で、同じキーが既に平文で存在するため、
# gpg/SecretStore で守る意味が消えた。.env を単一の源にする。
# 認証は ANTHROPIC_AUTH_TOKEN を使う（ANTHROPIC_API_KEY と併用すると Claude Code が警告するため一本化）。
alias claude-ds='ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic \
  ANTHROPIC_AUTH_TOKEN=$(grep "^DEEPSEEK_API_KEY=" ~/.reasonix/.env | head -n1 | cut -d= -f2-) \
  ANTHROPIC_MODEL=deepseek-v4-pro[1m] \
  ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-pro[1m] \
  ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-pro[1m] \
  ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash \
  CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-flash \
  claude'

alias claude-ds-flash='ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic \
  ANTHROPIC_AUTH_TOKEN=$(grep "^DEEPSEEK_API_KEY=" ~/.reasonix/.env | head -n1 | cut -d= -f2-) \
  ANTHROPIC_MODEL=deepseek-v4-flash \
  ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-pro[1m] \
  ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-flash \
  ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash \
  CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-flash \
  claude'

# reasonix は ~/.reasonix/.env からキーを自前で読むため、ラッパー（エイリアス）は不要。

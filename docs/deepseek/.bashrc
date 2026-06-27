# DeepSeek版 Claude Code
alias claude-ds='ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic \
  ANTHROPIC_API_KEY=$(gpg -d ~/.deepseek-api-key 2>/dev/null) \
  ANTHROPIC_MODEL=deepseek-v4-pro[1m] \
  ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-pro[1m] \
  ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-pro[1m] \
  ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash \
  CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-flash \
  claude'

alias claude-ds-flash='ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic \
  ANTHROPIC_API_KEY=$(gpg -d ~/.deepseek-api-key 2>/dev/null) \
  ANTHROPIC_MODEL=deepseek-v4-flash \
  ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-pro[1m] \
  ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-flash \
  ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash \
  CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-flash \
  claude'

# Reasonix (DeepSeek専用低燃費エージェント)
alias reasonix='DEEPSEEK_API_KEY=$(gpg -d ~/.deepseek-api-key 2>/dev/null) \
  reasonix'

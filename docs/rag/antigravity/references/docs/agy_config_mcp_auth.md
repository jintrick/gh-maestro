# Antigravity MCP Authentication

Antigravity handles various security protocols to ensure safe connection to MCP servers.

## Google Application Default Credentials (ADC)
Used for accessing Google Cloud services via MCP.
- **Config**: Set `"authProviderType": "google_credentials"` in `mcp_config.json`.
- **Setup**: Run `gcloud auth application-default login`.

## OAuth Flow
Used for servers requiring third-party authorization.
- **Redirect URI**: `https://antigravity.google/oauth-callback`
- **Tokens**: Access tokens are stored and refreshed automatically in `~/.gemini/antigravity/mcp_oauth_tokens.json`.

## Custom Headers
For API-key based authentication, use the `headers` object:
```json
"headers": {
  "Authorization": "Bearer YOUR_API_TOKEN"
}
```

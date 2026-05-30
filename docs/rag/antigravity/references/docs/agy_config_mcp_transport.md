# Antigravity MCP Integration

Antigravity supports the Model Context Protocol (MCP) to connect the AI with local tools, databases, and external services in real-time.

## Configuration Paths
- **Global Config**: `~/.gemini/antigravity/mcp_config.json`
- **OAuth Tokens**: `~/.gemini/antigravity/mcp_oauth_tokens.json`

## mcp_config.json Structure
The file contains an `mcpServers` object defining each server.

### Example Schema
```json
{
  "mcpServers": {
    "serverName": {
      "command": "path/to/executable",
      "args": ["--arg1", "value1"],
      "env": { "API_KEY": "your-api-key" },
      "disabled": false
    }
  }
}
```

## Supported Transport Layers
One of the following is required:
- **`command`** (string): Path to executable for **stdio** transport.
- **`serverUrl`** (string): URL for **Streamable HTTP** transport.

## Configuration Properties
- **`args`** (string[]): Arguments for stdio.
- **`env`** (object): Environment variables for stdio.
- **`cwd`** (string): Working directory for stdio.
- **`headers`** (object): Custom HTTP headers for HTTP transport.
- **`authProviderType`** (string): Use `"google_credentials"` for Application Default Credentials (ADC).
- **`oauth`** (object): Manual OAuth credentials (`clientId`, `clientSecret`).
- **`disabled`** (boolean): Temporarily disable a server.
- **`disabledTools`** (string[]): Specific tools to hide from the agent.

## Authentication Methods
### Google ADC
Set `authProviderType` to `"google_credentials"`. Requires `gcloud auth application-default login`.

### OAuth
- **DCR (Dynamic Client Registration)**: No config needed if supported by server.
- **Manual**: Provide `oauth` object and register `https://antigravity.google/oauth-callback` as redirect URI.

### Custom Headers
Used for API keys or Bearer tokens in the `headers` object.

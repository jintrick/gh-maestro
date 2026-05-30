# Antigravity Plugins

Plugins are namespaced bundles that contain skills, agents, rules, MCP servers, and hooks as a single deployable unit.

## Installation & Staging
When a plugin is installed, the CLI stages the files in the home directory under:
`~/.gemini/antigravity-cli/plugins/<plugin_name>/`

The Antigravity Agent automatically discovers and loads these staged customizations.

## Plugin Structure
```text
~/.gemini/antigravity-cli/
├── plugins/
│   └── <plugin_name>/
│       ├── plugin.json         # Required marker file
│       ├── mcp_config.json     # Optional MCP server definitions
│       ├── hooks.json          # Optional event hooks definition
│       ├── skills/             # Optional skills
│       ├── agents/             # Optional subagents
│       └── rules/              # Optional rules
└── import_manifest.json        # Tracking manifest
```

## Accessing Components
Once staged and loaded, plugin components (such as skills or subagents) can be interacted with using slash commands within the CLI.

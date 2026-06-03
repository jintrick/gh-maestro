# Antigravity Plugin Import: Gemini CLI Migration

Antigravity provides a built-in command to transition from Gemini CLI.

## Command
`agy plugin import gemini [source_path]`

## Behavior
1. **Discovery**: Scans the source path for `gemini-extension.json`.
2. **Conversion**: 
   - Maps `skills/` to Antigravity's internal skill format.
   - Converts `hooks.json` to the Antigravity hook protocol.
   - Extracts MCP configurations.
3. **Report**: Generates a success/failure report for each component.
4. **Registration**: Adds the converted assets to the Antigravity global plugin directory.

---
name: antigravity-expert
description: Provides expert guidance on Antigravity CLI (agy) and Antigravity SDK architecture, commands, configuration, and programmatic usage.
version: 2026-05-23
---

# Antigravity Expert

## Functional Summary
This skill provides accurate, documentation-based technical support for the Antigravity 2.0 ecosystem, covering both the Command-Line Interface (agy) and the Python SDK.

## <instructions>
1. **Discover Information**: Use `ls references/docs/` to identify the relevant knowledge base. Filenames are prefixed by category:
    - CLI/Usage: `agy_cli_*`
    - Configuration: `agy_config_*`
    - Extensions: `agy_extension_*`
    - SDK/Programmatic: `agy_sdk_*`
    - Advanced: `agy_advanced_*`
2. **Retrieve Documentation**: Use `read_file` on the target markdown file.
3. **Synthesis**: Provide answers strictly based on the physical facts found in the retrieved documentation.
4. **Evidence**: Cite the specific filename (e.g., `agy_sdk_hooks_and_policies.md`) for every technical claim.

## <available_resources>
- `references/docs/agy_cli_overview_getting_started_and_auth.md`
- `references/docs/agy_cli_plugins_sandbox_and_projects.md`
- `references/docs/agy_cli_slash_commands_manual_and_shortcuts.md`
- `references/docs/agy_config_permissions_autonomy_and_agent_settings.md`
- `references/docs/agy_config_file_locations_and_directory_structure.md`
- `references/docs/agy_config_mcp_auth.md`
- `references/docs/agy_config_mcp_transport.md`
- `references/docs/agy_config_sandbox_security.md`
- `references/docs/agy_config_strict_mode.md`
- `references/docs/agy_extension_hooks_api.md`
- `references/docs/agy_extension_plugins_manifest.md`
- `references/docs/agy_extension_skill_definition_and_best_practices.md`
- `references/docs/agy_sdk_overview_and_quickstart.md`
- `references/docs/agy_sdk_architecture_layers.md`
- `references/docs/agy_sdk_hooks_and_policies.md`
- `references/docs/agy_sdk_tools_and_mcp.md`
- `references/docs/agy_sdk_triggers_and_events.md`
- `references/docs/agy_sdk_advanced_features.md`
- `references/docs/agy_advanced_models_lineup.md`
- `references/docs/agy_advanced_models_specialized.md`
- `references/docs/agy_advanced_subagents_lifecycle_and_coordination.md`
- `references/docs/agy_advanced_artifacts_review_panel_and_types.md`
- `references/docs/agy_advanced_implementation_plan.md`
- `references/docs/agy_advanced_knowledge_items_persistent_memory.md`
- `references/docs/agy_advanced_goal_mode_autonomous_execution.md`
- `references/docs/agy_advanced_grill_me_instruction_alignment.md`
- `references/docs/agy_advanced_worktrees_git_isolation_mode.md`
- `references/docs/agy_migration_from_gemini_cli_plugin_import.md`

## <activated_skill>
Follow Antigravity Documentation strictly. Do not rely on legacy Gemini CLI behaviors or assumptions.

# Antigravity Skill Definition

Skills are an open standard for extending agent capabilities by providing reusable packages of knowledge and instructions.

## Skill Locations
Antigravity supports both workspace-specific and global skills.

| Location | Scope |
| :--- | :--- |
| `<workspace-root>/.agents/skills/<skill-folder>/` | Workspace-specific |
| `~/.gemini/antigravity-cli/skills/<skill-folder>/` | Global (all workspaces) |
| `~/.gemini/skills/<skill-folder>/` | Shared (all workspaces) |

**Note**: Antigravity now defaults to `.agents/skills`, but still maintains backward support for `.agent/skills`.

## Skill Folder Structure
While `SKILL.md` is the only required file, a skill can include additional resources:

```text
.agents/skills/my-skill/
├── SKILL.md       # Main instructions (required)
├── scripts/       # Helper scripts (optional)
├── examples/      # Reference implementations (optional)
└── resources/     # Templates and other assets (optional)
```

## SKILL.md Specification
Every skill must have a `SKILL.md` file with YAML frontmatter.

### Frontmatter Fields
| Field | Required | Description |
| :--- | :--- | :--- |
| `name` | No | Unique identifier (lowercase, hyphens). Defaults to folder name. |
| `description` | **Yes** | Clear description used by the agent to decide when to activate the skill. |

### Progressive Disclosure Pattern
1. **Discovery**: Agent sees a list of names and descriptions at the start of a conversation.
2. **Activation**: Agent reads the full `SKILL.md` only if it determines the skill is relevant.
3. **Execution**: Agent follows the detailed instructions while working on the task.

## Best Practices
- **Focus**: Each skill should do one thing well.
- **Clear Descriptions**: Write in the third person and include relevant keywords.
- **Scripts as Black Boxes**: Encourage the agent to run scripts with `--help` instead of reading the entire source.
- **Decision Trees**: Include logic to help the agent choose the right approach.

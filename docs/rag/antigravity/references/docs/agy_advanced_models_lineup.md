---
source_url: agy models (実行結果)
original_title: Antigravity Model Lineup
fetched_at: 2026-10-16
---

# Antigravity モデル一覧

`agy models` の実行結果に基づく（2026-10-16時点）。利用可能なモデルはアカウントと時期で変わるため、使う前に `agy models` で確認する。

## 利用可能なモデル

左列が `--model` に渡すID、右列が表示名。

| モデルID | 表示名 |
| :--- | :--- |
| `gemini-4-argon-medium` | Gemini 4 Argon (Medium) |
| `gemini-4-argon-high` | Gemini 4 Argon (High) |
| `gemini-4-argon-low` | Gemini 4 Argon (Low) |
| `gemini-3.8-flash-high` | Gemini 3.8 Flash (High) |
| `gemini-3.8-flash-medium` | Gemini 3.8 Flash (Medium) |
| `gemini-3.8-flash-low` | Gemini 3.8 Flash (Low) |
| `claude-opus-5-5-low` | Claude Opus 5.5 (Low) |
| `claude-opus-5-5-medium` | Claude Opus 5.5 (Medium) |
| `claude-opus-5-5-high` | Claude Opus 5.5 (High) |
| `claude-sonnet-5-5-low` | Claude Sonnet 5.5 (Low) |
| `claude-sonnet-5-5-medium` | Claude Sonnet 5.5 (Medium) |
| `claude-sonnet-5-5-high` | Claude Sonnet 5.5 (High) |
| `gpt-oss-120b-medium` | GPT-OSS 120B (Medium) |

画像生成などに使う特化モデルはこの一覧に出ない（`agy_advanced_models_specialized.md` を参照）。

## モデルの指定

- 起動時: `agy --model <モデルID>` でそのセッションのモデルを指定する（`agy_cli_command_line_flags_and_subcommands_startup_options_reference.md`）。
- TUI内: `/model` で切り替える（`agy_cli_slash_commands_manual_and_shortcuts.md`）。

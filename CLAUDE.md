# gh-maestro

GitHubを永続状態として使い、複数のAIエージェントを協調させるローカルオーケストレーションシステム。

<!-- BEGIN: synced from AGENTS.md (scripts/sync-agents-md.js) -->

# gh-maestro Agent Guide

gh-maestro is a local orchestration system that uses GitHub as durable state and coordinates multiple AI agents across planning, implementation, review, merge, and retrospective.

This file is for agent-facing operating rules and project intent. Do not use it as a script inventory or architecture dump; details that are obvious from the code should stay in the code.

## Operating Model

gh-maestro is built around quota economics.

- Use expensive models for judgment: requirements, design tradeoffs, review triage, and human collaboration.
- Use cheaper or faster workers for bounded execution: implementation, search-heavy investigation, log reading, and mechanical review passes.
- Workers do not own product decisions, merge decisions, or priority calls. They report facts, produce code, or emit structured findings.
- The orchestrator and the human own approval, rejection, prioritization, and final merge judgment.

## Agent Roles

Keep role boundaries explicit:

- Orchestrator: collaborates with the human, drafts Issues, starts workers, triages review output, and coordinates merge/retrospective.
- Coder: implements one scoped Issue in its own worktree.
- Explorer: gathers facts only.
- Investigator: diagnoses bugs and reports root cause, impact, and fix direction.
- Review Manager: coordinates independent review passes and emits structured findings; deterministic scripts handle posting.

When adding or changing roles, prefer data-driven configuration and shared launch helpers over per-agent special cases.

## Review Policy

Automated review is advisory.

- Automated review must not approve PRs.
- Keep review findings structured, reproducible, and anchored to changed code when possible.
- Do not rely on a single agent's judgment for broad review coverage; preserve independent review perspectives.
- Deterministic validation and publishing should stay outside model prompts where practical.

## Source Of Truth

Canonical sources live in the repository, not installed copies.

- Edit skill sources under `skills/`.
- Do not hand-edit installed copies under user-level skill directories or generated agent directories.
- Prefer updating `skills/agents.yaml` for default agent configuration.
- Keep scripts in `scripts/`; do not hide executable logic inside skill directories.

After changing skills, script distribution, or agent defaults, run **from the `dev` branch** (after the changes are merged):

```sh
node scripts/install.js
```

**Never run `node scripts/install.js` from a WIP/unmerged feature branch.** It writes to the machine-global `~/.gh-maestro/` shared directory and will overwrite installed state with unreviewed, unmerged code.

## Change Discipline

- Prefer existing project patterns over new abstractions.
- Keep worker launch behavior shared and data-driven.
- Avoid reintroducing removed legacy review paths unless explicitly requested.
- Keep local/generated state out of commits unless it is intentionally tracked.
- Do not use destructive git or filesystem cleanup commands unless the user explicitly asks for them.

## Checks

- Run `npm test` for code or installer changes.
- Run `node scripts/install.js` after skill, script distribution, or `skills/agents.yaml` changes **— only from the `dev` branch after changes are merged. Never from a WIP branch.**
- If CLI launch flags, subcommands, or argument combinations change, execute a minimal real command for that CLI path, not only `--help`.
- For doc-only changes, tests are optional unless the documentation changes operational instructions that should be verified.

## Local Reference Docs

Use local RAG docs before implementing or answering about tool behavior:

- Codex: `docs/rag/codex/`
- Claude Code: `docs/rag/claude-code/`
- Antigravity CLI: `docs/rag/antigravity/`
- WezTerm: `docs/rag/wezterm/`

Do not infer CLI paths, flags, config files, skill locations, or sandbox behavior from memory when local RAG docs exist.

<!-- END: synced from AGENTS.md -->

quota経済・エージェントの役割・レビュー方針・変更規律は上記（AGENTS.mdから同期）を参照。このファイルにはClaude Code固有の、毎セッション必ず適用すべきルールのみを置く。

## Git操作ルール

- ファイル変更が承認されたら、同じターン内で即座にcommit・pushする。別途指示を待たない。
- `git reset --hard` は必ずユーザーに確認してから実行する。無断で実行しない。
- pushがnon-fast-forwardで失敗した場合、`git reset --hard` は使わない。状況をユーザーに報告し、対応方針を確認する。

## Installルール

- `node scripts/install.js` はマシングローバルな共有ディレクトリ `~/.gh-maestro/` に書き込む。
- **WIP・未マージのfeatureブランチから実行しないこと。** 変更がマージされた後、`dev`（または`main`）ブランチからのみ実行する。
- 開発時の動作確認等でWIPブランチから実行する必要がある場合は `node scripts/install.js --force` を使う。
- **実行前に必ず自問する**: 「今回の変更でエージェントの振る舞いが変わったなら、それを説明する`skills/**/SKILL.md`は更新済みか？」scriptsだけ直してSKILL.mdを触らずにinstallするのは、対象の変更点によっては何も反映しない空振りになりうる（プロセス統合ルール参照）。

## プロセス統合ルール

- このプロジェクトではSKILL.mdがエージェントの実際の動作を規定する本線であり、`scripts/`配下の実装はSKILL.mdから呼ばれて初めて意味を持つ道具に過ぎない。スクリプトを実装・変更しても、それがSKILL.mdに正しく反映されるまで実運用では何も変わらない。
- 常駐/バックグラウンドプロセス（デーモン型スクリプト）への変更は、新規実装か既存プロセスへの機能追加かを問わず、スクリプト自体の実装とユニットテストが通っただけでは完了とみなさない。
- 完了と判断する前に、以下の両方を確認する（どちらか一方だけでは不十分）：
  1. **実機確認**: 実際のセッションでそのプロセスを起動するはずのもの（オーケストレーターの操作手順・起動フック等）が本当に起動処理を行うこと、そしてそのプロセスの効果（配送・通知・再開等）が意図した相手まで実際に届くことを、実機でエンドツーエンドに確認する。
  2. **SKILL.md整合性確認**: 変更によって振る舞いが変わった箇所に関連する既存のSKILL.md記述（起動手順・配送経路の説明・禁止事項等）を洗い出し、新しい実態と矛盾していないか確認・修正する。スクリプトの実機確認だけで終え、SKILL.mdの更新を「別フェーズに先送り」しない。

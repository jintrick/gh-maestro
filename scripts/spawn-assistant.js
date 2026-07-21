#!/usr/bin/env node
// spawn-assistant.js
// issue起票と同時に自動起動する、対話型・オーケストレーター管理対象外のワーカー「assistant」を
// 起動する。spawn-worker.js のagy専用・worktreeなし版:
//   - 専用worktreeを持たない。$WORKSPACE 直下で動作し、workers.json を読んで他ワーカーの
//     worktreeを動的に発見する（gh-maestro-assistant SKILL.md参照）
//   - workers.json に登録しない（オーケストレーターの管理対象外という設計そのもの）
//   - ペイン分割ではなく新規WezTermウィンドウで起動する（他ワーカーのレイアウトに依存しない）
//   - agy専用。--prompt-interactive による対話セッションとして起動する（--printのワンショットではない）
//
// Usage:
//   node spawn-assistant.js --issue <N> --workspace <path> [--repo <owner/repo>]
//
// 標準出力: ASSISTANT_LAUNCHED:<issue> pane=<paneId>

'use strict';

const { spawnSync } = require('./child-process');
const { existsSync, mkdirSync, writeFileSync } = require('fs');
const { resolve } = require('path');
const { resolveAgentConfig } = require('./shared/resolve-config');
const { checkAgentExists } = require('./agent-exec');
const { buildAgentCommandArgs } = require('./agent-launch');
const { launchAgentInWindow } = require('./shared/pane-launch');
const { setAssistant } = require('./shared/assistants-registry');
const { parseFlags, hasHelpFlag } = require('./shared/workspace');

const AGENT_ID = 'agy-interactive';

const USAGE = `spawn-assistant.js — issue起票と同時に自動起動する対話型ワーカー「assistant」を起動する

Usage: node spawn-assistant.js --issue <N> --workspace <path> [--repo <owner/repo>]

Arguments:
  --issue <N>           アンカー Issue 番号（正の整数）
  --workspace <path>    ワークスペースのルートパス
  --repo <owner/repo>   対象リポジトリ（省略時は workspace の git remote から解決）

assistant は agy（Antigravity）専用の対話型ワーカーで、専用worktreeを持たず $WORKSPACE 直下で
動作する。workers.json には登録されない（オーケストレーターの管理対象外）。新規WezTermウィンドウで
起動し、Issue がクローズされる（finalize-issue.js 経由）と強制終了される。

Output (stdout):
  ASSISTANT_LAUNCHED:<issue> pane=<paneId>  起動成功`;

/**
 * パスをスラッシュ区切りに変換する（spawn-worker.js の toUnix と同一パターン）。
 * @param {string} p
 * @returns {string}
 */
function toUnix(p) {
  return p.replace(/\\/g, '/');
}

/**
 * --repo が明示されなければ gh repo view で解決する。
 * @param {string} workspace
 * @param {string|null|undefined} explicitRepo
 * @param {(workspace: string) => {status: number, stdout: string}} ghRepoViewFn
 * @returns {string|null}
 */
function resolveRepo(workspace, explicitRepo, ghRepoViewFn) {
  if (explicitRepo) return explicitRepo;
  const r = ghRepoViewFn(workspace);
  if (r.status !== 0) return null;
  const out = (r.stdout || '').toString().trim();
  return out || null;
}

function defaultGhRepoView(workspace) {
  return spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd: workspace, encoding: 'utf8' });
}

/**
 * 初期プロンプトファイルの内容を組み立てる（純粋関数）。
 * @param {{issue: string|number, repo: string, workspace: string}} ctx
 * @returns {string}
 */
function buildPromptFileContent({ issue, repo, workspace }) {
  const contextLines = [
    `REPO=${repo}`,
    `WORKSPACE=${toUnix(workspace)}`,
    `ISSUE=${issue}`,
  ];
  return `issue起票と同時に自動起動しました。gh-maestro-assistantスキルを発動し、指示に従って人間と対話してください。

以下の変数が与えられています：
${contextLines.join('\n')}

このワーカーには専用のworktreeがありません。関連するworktreeは $WORKSPACE/.gh-maestro/workers.json を
読んで動的に発見してください（詳細はスキル本文を参照）。`;
}

/**
 * agy の --prompt-interactive に渡す短い1行プロンプトを組み立てる（純粋関数）。
 * @param {{issue: string|number, promptFile: string}} params
 * @returns {string}
 */
function buildShortPrompt({ issue, promptFile }) {
  return `issue起票と同時に自動起動しました。gh-maestro-assistantスキルを発動してください。詳細は ${toUnix(promptFile)} を参照してください。ISSUE=${issue}`;
}

module.exports = { resolveRepo, buildPromptFileContent, buildShortPrompt, toUnix, AGENT_ID };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const { values, rest, exitFlagMiss } = parseFlags(argv, ['--issue', '--workspace', '--repo']);

  // 値欠落は常にエラー優先（フェイルクローズ）とし、help判定より先に確定させる
  // （argv-parsing-pitfalls ルール参照）。
  if (exitFlagMiss) {
    console.error(USAGE);
    process.exit(1);
  }

  if (hasHelpFlag(rest)) {
    console.log(USAGE);
    process.exit(0);
  }

  if (rest.length > 0) {
    console.error(`spawn-assistant: 未知の引数です: ${rest.join(' ')}`);
    console.error(USAGE);
    process.exit(1);
  }

  const issue = values['--issue'];
  const workspace = values['--workspace'];
  const explicitRepo = values['--repo'];

  const fail = (msg) => {
    console.error(`spawn-assistant: ${msg}`);
    process.exit(1);
  };

  if (!issue) fail('--issue が必要です');
  if (!/^[1-9][0-9]*$/.test(issue)) fail('--issue は正の整数である必要があります');
  if (!workspace) fail('--workspace が必要です');
  if (!existsSync(workspace)) fail(`--workspace が存在しません: ${workspace}`);

  const repo = resolveRepo(workspace, explicitRepo, defaultGhRepoView);
  if (!repo) fail('--repo を解決できませんでした（gh repo view 失敗）。--repo を明示してください');

  const homedir = process.env.HOME || process.env.USERPROFILE || '';
  const agentConfig = resolveAgentConfig(AGENT_ID, { workspace, homedir });
  if (!agentConfig) {
    fail(`エージェント "${AGENT_ID}" の設定を解決できません。agent-defaults.json が破損していないか確認してください。`);
  }

  if (!checkAgentExists(agentConfig.command)) {
    fail(`エージェント "${AGENT_ID}" のコマンド "${agentConfig.command}" が見つかりません。agy CLIがインストールされているか確認してください。`);
  }

  const promptDir = resolve(workspace, '.gh-maestro', 'assistants', `issue-${issue}`);
  mkdirSync(promptDir, { recursive: true });
  const promptFile = resolve(promptDir, 'prompt.md');
  writeFileSync(promptFile, buildPromptFileContent({ issue, repo, workspace }), 'utf8');

  const shortPrompt = buildShortPrompt({ issue, promptFile });

  let agentCmdArgs;
  try {
    agentCmdArgs = buildAgentCommandArgs(agentConfig, { shortPrompt });
  } catch (e) {
    fail(`エージェント "${AGENT_ID}" の起動引数を組み立てられません: ${e.message}`);
  }

  let paneId;
  try {
    // onExit フックは付けない — assistant はオーケストレーターの管理対象外であり、
    // 異常終了をオーケストレーターに通知する経路を持たせない設計そのもの。
    ({ paneId } = launchAgentInWindow({
      argv: agentCmdArgs,
      cwd: workspace,
      env: { GH_MAESTRO_ASSISTANT_ISSUE: String(issue) },
    }));
  } catch (e) {
    fail(e.message);
  }

  setAssistant(workspace, issue, { paneId, launchedAt: new Date().toISOString() });

  console.log(`ASSISTANT_LAUNCHED:${issue} pane=${paneId}`);
}

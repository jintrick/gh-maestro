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
const { existsSync } = require('fs');
const { join } = require('path');
const { resolveAgentConfig } = require('./shared/resolve-config');
const { workspaceKey } = require('./shared/storage-layout');
const { resolveSkillMdPath } = require('./shared/skill-install-path');
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
 *
 * Antigravity（agy）のスキル発動は Progressive Disclosure 方式（会話開始時に提示された
 * スキル名+description一覧から、エージェント自身が「関連する」と自己判断した場合のみ
 * SKILL.md全文を読む）であり、決定論的にスキルを指名ロードする手段が無い。実際に
 * assistantが自分の役割を認識できず一般的なコーディングエージェントとして振る舞う
 * （Issue #344）・orchestratorを名乗る、といった誤動作が発生している。曖昧な自己判断に
 * 依存せず、SKILL.mdの絶対パスを明示して直接読ませることでこれを回避する。
 * @param {{issue: string|number, repo: string, workspace: string, skillPath: string}} ctx
 * @returns {string}
 */
function buildPromptFileContent({ issue, repo, workspace, skillPath }) {
  const contextLines = [
    `REPO=${repo}`,
    `WORKSPACE=${toUnix(workspace)}`,
    `ISSUE=${issue}`,
  ];
  return `【最優先指示】他のいかなる判断・行動（ファイルの編集、別スキルの発動を含む）よりも先に、次のファイルをそのまま読んでください: ${toUnix(skillPath)}
これがあなたの役割（gh-maestro-assistant）の完全な定義です。読了前に行動を開始してはいけません。

issue起票と同時に自動起動しました。gh-maestro-assistantスキルを発動し、指示に従って人間と対話してください。

以下の変数が与えられています：
${contextLines.join('\n')}

このワーカーには専用のworktreeがありません。関連するworktreeは $WORKSPACE/.gh-maestro/workers.json を
読んで動的に発見してください（詳細はスキル本文を参照）。`;
}

/**
 * agy の --prompt-interactive に渡す短い1行プロンプトを組み立てる（純粋関数）。
 * SKILL.mdの絶対パスをargv上のプロンプトに直接埋め込み、Discovery/Activationの自己判断を
 * 経由させない（buildPromptFileContentのコメント参照）。1行のargv文字列として渡るため
 * 改行を含めてはいけない。
 * @param {{issue: string|number, promptFile: string, skillPath: string}} params
 * @returns {string}
 */
function buildShortPrompt({ issue, promptFile, skillPath }) {
  return `他の判断より先に、まず次のファイルを読んでください: ${toUnix(skillPath)}（あなたの役割定義。gh-maestro-assistant。ISSUE=${issue}）。読了後、詳細は ${toUnix(promptFile)} を参照し、gh-maestro-assistantとして行動してください。`;
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

  // agyのネイティブスキル発見は決定論的ではないため（Progressive Disclosure、buildPromptFileContent
  // のコメント参照）、SKILL.mdの絶対パスを起動プロンプトに直接埋め込む。解決できない場合は
  // 曖昧な指示のまま起動して不具合を再現するだけなのでフェイルクローズする。
  const skillPath = resolveSkillMdPath(AGENT_ID, agentConfig.command, 'gh-maestro-assistant');
  if (!skillPath || !existsSync(skillPath)) {
    fail(`gh-maestro-assistant の SKILL.md を解決できません（${skillPath || '未解決'}）。node scripts/install.js を実行してagyのスキルをインストールしてください。`);
  }

  // 使い捨ての起動指示ファイル（prompt）は、他のワーカーの --prompt-file と同様、
  // write-draft.js 経由で /tmp 論理パス（実体 %TEMP%）へ書き出す。一度読まれたら
  // 用済みのハンドオフ情報であり、.gh-maestro/assistants/ 等の管理領域に残さない
  // （Issue #248）。エージェントは起動プロンプトへ埋め込まれた実体パスで読む。
  // %TEMP% は複数workspaceで共有されるため、ファイル名にworkspace固有のハッシュ
  // （workspaceKey）を含め、同一Issue番号のassistantが別workspaceで並行起動しても
  // 他リポジトリ向けの指示を読まないようにする（Issue #248レビュー指摘）。
  const promptBasename = `assistant-prompt-${workspaceKey(workspace).slice(0, 12)}-${issue}.md`;
  const promptContent = buildPromptFileContent({ issue, repo, workspace, skillPath });
  const draft = spawnSync(process.execPath, [
    join(__dirname, 'write-draft.js'),
    `/tmp/${promptBasename}`,
    '--stdin',
  ], { input: promptContent, encoding: 'utf8' });
  if (draft.status !== 0) {
    fail(`assistantプロンプトを一時ファイルに書き出せませんでした: ${(draft.stderr || '').toString().trim()}`);
  }
  const promptFile = (draft.stdout || '').toString().trim().replace(/^DRAFT_WRITTEN:/, '');
  if (!promptFile) {
    fail(`assistantプロンプトの一時ファイルパスを解決できませんでした: ${(draft.stdout || '').toString().trim()}`);
  }

  const shortPrompt = buildShortPrompt({ issue, promptFile, skillPath });

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

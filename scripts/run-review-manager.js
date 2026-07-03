#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('./child-process');
const { buildAgentCommandArgs } = require('./agent-launch');

const USAGE = `run-review-manager.js — Codex Review Managerをheadless起動してPRレビューを投稿する

Usage: node run-review-manager.js <PR> <REPO> <WORKSPACE>

Arguments:
  <PR>         レビュー対象の PR 番号
  <REPO>       GitHub リポジトリ(owner/repo)
  <WORKSPACE>  ワークスペースの絶対パス`;

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

const [pr, repo, workspace] = argv;
if (!pr || !repo || !workspace) {
  console.error(USAGE);
  process.exit(1);
}

const ghDir = path.join(workspace, '.gh-maestro');
const lockFile = path.join(ghDir, `review-manager-${pr}.running`);
const logFile = path.join(ghDir, `review-manager-${pr}.log`);
const outputFile = path.join(ghDir, `review-manager-${pr}.json`);
const promptFile = path.join(os.tmpdir(), `review-manager-prompt-${pr}-${Date.now()}.md`);

function log(msg) {
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
}

function cleanup() {
  try { fs.unlinkSync(promptFile); } catch {}
  try { fs.unlinkSync(lockFile); } catch {}
}

function buildPrompt() {
  const toUnix = p => p.replace(/\\/g, '/');
  return `gh-maestro-reviewerスキルを発動し、Review ManagerとしてPRレビューを実行してください。

PR=${pr}
REPO=${repo}
WORKSPACE=${toUnix(workspace)}
OUTPUT=${toUnix(outputFile)}

必ず以下を守ってください。
- GitHubへ投稿しない
- 採否判断しない
- 3観点のReviewerを独立に並列spawnする
- Reviewerには該当する観点別基準ファイルを読ませる
- 最終結果はOUTPUTのJSONだけに書き出す
`;
}

fs.mkdirSync(ghDir, { recursive: true });
log(`run-review-manager started pr=${pr} repo=${repo}`);

try {
  fs.writeFileSync(promptFile, buildPrompt(), 'utf8');
  spawnSync('git', ['-C', workspace, 'fetch', 'origin', `pull/${pr}/head`], { stdio: 'ignore' });

  const agentArgs = buildAgentCommandArgs({
    command: process.env.GH_MAESTRO_RM_COMMAND || 'codex',
    extraArgs: [
      'exec',
      '--cd', workspace,
      '--sandbox', 'workspace-write',
    ],
    promptDelivery: 'positional',
  }, {
    shortPrompt: `Read ${promptFile.replace(/\\/g, '/')} and execute it.`,
  });

  log(`spawning ${agentArgs.join(' ')}`);
  const result = spawnSync(agentArgs[0], agentArgs.slice(1), {
    cwd: workspace,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.error) log(`spawn error: ${result.error.message}`);
  if (result.stdout) log(result.stdout);
  if (result.stderr) log(result.stderr);
  log(`${agentArgs[0]} exited with status ${result.status}`);
  if (result.status !== 0) process.exit(result.status ?? 1);

  if (!fs.existsSync(outputFile)) {
    log(`RM output not found: ${outputFile}`);
    process.exit(1);
  }

  const publish = spawnSync(process.execPath, [
    path.join(__dirname, 'review-publisher.js'),
    outputFile,
  ], {
    cwd: workspace,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (publish.stdout) log(publish.stdout);
  if (publish.stderr) log(publish.stderr);
  log(`review-publisher exited with status ${publish.status}`);
  process.exit(publish.status ?? 0);
} finally {
  cleanup();
}

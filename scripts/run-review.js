#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const [,, pr, repo, workspace] = process.argv;
if (!pr || !repo || !workspace) {
  console.error('Usage: run-review.js <PR> <REPO> <WORKSPACE>');
  process.exit(1);
}

const ghDir = path.join(workspace, '.gh-maestro');
const lockFile = path.join(ghDir, `review-${pr}.running`);
const logFile = path.join(ghDir, `review-${pr}.log`);

function log(msg) {
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
}

function cleanupAndExit(code) {
  if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
  process.exit(code);
}

fs.mkdirSync(ghDir, { recursive: true });
log(`run-review started pr=${pr} repo=${repo}`);

// レビュアーエージェントを ~/.gh-maestro/agents.json から解決する。
// spawn-worker.js と同じ仕組み: エージェント定義の command + extraArgs をそのまま使い、
// DeepSeek の APIキー取得・env 解決はラッパー（claude-ds）側に一任する。
// run-review.js が自前で Get-Secret / gpg や ANTHROPIC_* を組むと、ラッパーと食い違い
// （AUTH_TOKEN vs API_KEY 等）や二重メンテが発生するため、ここでは再実装しない。
const reviewAgentId = process.env.GH_MAESTRO_REVIEW_AGENT || 'claude-ds';
const agentsJsonPath = path.join(os.homedir(), '.gh-maestro', 'agents.json');
let reviewAgent;
try {
  const agents = JSON.parse(fs.readFileSync(agentsJsonPath, 'utf8'));
  reviewAgent = agents.find(a => a.id === reviewAgentId);
} catch (e) {
  log(`agents.json 読み込み失敗 (${agentsJsonPath}): ${e.message}`);
  cleanupAndExit(1);
}
if (!reviewAgent) {
  log(`レビュアーエージェント "${reviewAgentId}" が agents.json に見つかりません`);
  cleanupAndExit(1);
}

// Build prompt from template
const promptTemplate = fs.readFileSync(path.join(__dirname, 'review-prompt.md'), 'utf8');
const prompt = promptTemplate
  .replace(/<PR番号>/g, pr)
  .replace(/<REPO>/g, repo);

const tmpPrompt = path.join(os.tmpdir(), `review-prompt-${pr}-${Date.now()}.md`);
fs.writeFileSync(tmpPrompt, prompt);

// Fetch PR head so git show <commit>:<path> works for line number verification
spawnSync('git', ['-C', workspace, 'fetch', 'origin', `pull/${pr}/head`], { stdio: 'ignore' });

// レビュアーエージェントを spawn-worker.js と同じ要領で起動する。
// command + extraArgs の後ろにヘッドレス実行用の引数を連結する。
// 例 (claude-ds): pwsh -Command "claude-ds --dangerously-skip-permissions" \
//                   -p --append-system-prompt-file <tmpPrompt> PRレビューを開始せよ
// pwsh -Command は後続トークンをコマンド文字列に連結して再パースするため、claude-ds 関数が
// `claude @args` でこれらをそのまま claude に転送する。
const agentArgs = [
  ...(reviewAgent.extraArgs || []),
  '-p',
  '--append-system-prompt-file', tmpPrompt,
  'PRレビューを開始せよ',
];
log(`spawning ${reviewAgent.command} ${agentArgs.join(' ')}`);
const result = spawnSync(reviewAgent.command, agentArgs, {
  cwd: workspace,
  encoding: 'utf8',
  env: process.env,
  maxBuffer: 10 * 1024 * 1024,
});

if (result.error) log(`spawn error: ${result.error.message}`);
if (result.stdout) log(result.stdout);
if (result.stderr) log(result.stderr);
log(`${reviewAgent.command} exited with status ${result.status}`);

fs.unlinkSync(tmpPrompt);
cleanupAndExit(result.status ?? 0);

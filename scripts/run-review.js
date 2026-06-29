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

fs.mkdirSync(ghDir, { recursive: true });
log(`run-review started pr=${pr} repo=${repo}`);

// Get DeepSeek API key — Windows: SecretManagement, Linux: gpg
let apiKey;
if (process.platform === 'win32') {
  const r = spawnSync('powershell', ['-Command', 'Get-Secret -Name "DeepSeekAPIKey" -AsPlainText'], {
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    log(`Get-Secret failed: ${r.stderr}`);
    if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
    process.exit(1);
  }
  apiKey = r.stdout.trim();
} else {
  const r = spawnSync('gpg', ['-d', path.join(os.homedir(), '.deepseek-api-key')], {
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    log(`gpg decrypt failed: ${r.stderr}`);
    if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
    process.exit(1);
  }
  apiKey = r.stdout.trim();
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

// Run claude with DeepSeek env
log('spawning claude');
const result = spawnSync(
  'claude',
  ['--dangerously-skip-permissions', '-p', '--append-system-prompt-file', tmpPrompt, 'PRレビューを開始せよ'],
  {
    cwd: workspace,
    encoding: 'utf8',
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_API_KEY: apiKey,
      ANTHROPIC_MODEL: 'deepseek-v4-flash',
      ANTHROPIC_DEFAULT_MODEL: 'deepseek-v4-flash',
      CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-v4-flash',
    },
    maxBuffer: 10 * 1024 * 1024,
  }
);

if (result.stdout) log(result.stdout);
if (result.stderr) log(result.stderr);
log(`claude exited with status ${result.status}`);

fs.unlinkSync(tmpPrompt);
if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);

process.exit(result.status ?? 0);

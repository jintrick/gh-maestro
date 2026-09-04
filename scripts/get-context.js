#!/usr/bin/env node
// get-context.js
// orchestratorの起動コンテキストを取得してプロンプト注入用ブロックとして出力する

const { execSync } = require('child_process');
const { getCurrentBranch } = require('./shared/git-branch');
const { resolveWorkspace } = require('./shared/workspace');
const { readState } = require('./shared/read-state');

const USAGE = `get-context.js — orchestrator の起動コンテキストをプロンプト注入用ブロックとして出力する

Usage: node get-context.js

引数は取らない。「--workspace」引数相当の指定がないため、GH_MAESTRO_WORKSPACE env、
次にCWDから上方探索して WORKSPACE を解決し、git remote から REPO、現在のブランチから
BASE_BRANCH を解決して [gh-maestro session context] ブロックを stdout に出力する。
通常は /gh-maestro の起動フックが呼ぶ。`;

// CLI として実行されたときだけ動く。require されただけで git を叩き stdout を汚さないため。
// （install.js と同じイディオム。CommonJS のモジュールスコープでは top-level return が使える）
if (require.main !== module) return;

if (process.argv.slice(2).some(a => a === '--help' || a === '-h')) {
  console.log(USAGE);
  process.exit(0);
}

const workspace = resolveWorkspace();
if (!workspace) {
  console.error('ERROR: ワークスペースを解決できません。GH_MAESTRO_WORKSPACE または .gh-maestro/ のあるディレクトリで実行してください。');
  process.exit(1);
}

let repo = '';
try {
  const raw = execSync('git config --get remote.origin.url', { encoding: 'utf8' }).trim();
  const match = raw.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  repo = match ? match[1] : raw;
} catch {
  console.error('ERROR: git remote origin が取得できません。');
  process.exit(1);
}

let baseBranch = '';
try {
  baseBranch = getCurrentBranch(workspace);
} catch {}

let sessionId = '';
try {
  const stateResult = readState(workspace, 'orchestrator');
  if (stateResult.status === 'ok' && typeof stateResult.state.sessionId === 'string' && stateResult.state.sessionId) {
    sessionId = stateResult.state.sessionId;
  }
} catch {}

const unixWorkspace = workspace.replace(/\\/g, '/');

console.log('[gh-maestro session context]');
console.log(`REPO=${repo}`);
console.log(`WORKSPACE=${unixWorkspace}`);
if (baseBranch) console.log(`BASE_BRANCH=${baseBranch}`);
console.log('GH_MAESTRO_WORKER=orchestrator');
if (sessionId) console.log(`SESSION_ID=${sessionId}`);

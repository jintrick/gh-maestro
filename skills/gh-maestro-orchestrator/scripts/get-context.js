#!/usr/bin/env node
// get-context.js
// orchestratorの起動コンテキストを取得してプロンプト注入用ブロックとして出力する

const { execSync } = require('child_process');

const workspace = process.cwd();

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
  baseBranch = execSync('git branch --show-current', { encoding: 'utf8' }).trim();
} catch {}

console.log('[gh-maestro session context]');
console.log(`REPO=${repo}`);
console.log(`WORKSPACE=${workspace}`);
if (baseBranch) console.log(`BASE_BRANCH=${baseBranch}`);

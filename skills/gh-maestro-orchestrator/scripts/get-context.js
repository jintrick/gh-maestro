#!/usr/bin/env node
// get-context.js
// orchestratorの起動コンテキストを取得してプロンプト注入用ブロックとして出力する

const { execSync } = require('child_process');
const { existsSync, readFileSync } = require('fs');
const { resolve } = require('path');

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

const unixWorkspace = workspace.replace(/\\/g, '/');

console.log('[gh-maestro session context]');
console.log(`REPO=${repo}`);
console.log(`WORKSPACE=${unixWorkspace}`);
if (baseBranch) console.log(`BASE_BRANCH=${baseBranch}`);

const homedir = process.env.HOME || process.env.USERPROFILE || '';
const agentsJsonPath = resolve(homedir, '.gh-maestro', 'agents.json');
let agents = [];
if (existsSync(agentsJsonPath)) {
  try {
    agents = JSON.parse(readFileSync(agentsJsonPath, 'utf8'));
  } catch (e) {
    console.error(`WARNING: agents.json のパースに失敗しました: ${e.message}`);
  }
}
if (agents.length > 0) {
  console.log('');
  console.log('[gh-maestro available agents]');
  for (const a of agents) {
    console.log(`${a.id}: ${a.label}`);
  }
}

#!/usr/bin/env node
// get-context.js
// orchestratorの起動コンテキストを取得してプロンプト注入用ブロックとして出力する

const { execSync } = require('child_process');
const { resolve } = require('path');

const USAGE = `get-context.js — orchestrator の起動コンテキストをプロンプト注入用ブロックとして出力する

Usage: node get-context.js

引数は取らない。CWD を WORKSPACE とし、git remote から REPO、現在のブランチから
BASE_BRANCH を解決して [gh-maestro session context] ブロックを stdout に出力する。
通常は /gh-maestro の起動フックが呼ぶ。`;

if (process.argv.slice(2).some(a => a === '--help' || a === '-h')) {
  console.log(USAGE);
  process.exit(0);
}

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

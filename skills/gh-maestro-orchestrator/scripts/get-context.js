#!/usr/bin/env node
// get-context.js
// orchestratorの起動コンテキストを取得して標準出力に出力する

const { execSync } = require('child_process');

const workspace = process.cwd();

// git remote URLをowner/repo形式に正規化
let repo = '';
try {
  const raw = execSync('git config --get remote.origin.url', { encoding: 'utf8' }).trim();
  const match = raw.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  repo = match ? match[1] : raw;
} catch {
  console.error('ERROR: git remote origin が取得できません。');
  process.exit(1);
}

console.log(`REPO='${repo}'`);
console.log(`WORKSPACE='${workspace}'`);

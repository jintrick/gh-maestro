#!/usr/bin/env node
'use strict';

// グローバルポリシーとプロジェクト固有ポリシーをマージして標準出力する。
// レビュワーはこのスクリプトの出力をレビュー基準として使用する。
//
// Usage: node get-review-policy.js --workspace <path>

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const workspaceIdx = args.indexOf('--workspace');
if (workspaceIdx === -1 || !args[workspaceIdx + 1]) {
  console.error('Usage: get-review-policy.js --workspace <path>');
  process.exit(1);
}
const workspace = args[workspaceIdx + 1];

const globalPolicyPath  = path.join(process.env.HOME || process.env.USERPROFILE, '.gh-maestro', 'review-policy.md');
const projectPolicyPath = path.join(workspace, '.gh-maestro', 'review-policy.md');

const sections = [];

if (fs.existsSync(globalPolicyPath)) {
  sections.push(fs.readFileSync(globalPolicyPath, 'utf8').trim());
} else {
  console.error(`Warning: global review policy not found at ${globalPolicyPath}`);
}

if (fs.existsSync(projectPolicyPath)) {
  sections.push('---\n\n## プロジェクト固有ポリシー\n\n' + fs.readFileSync(projectPolicyPath, 'utf8').trim());
}

if (sections.length === 0) {
  console.error('Warning: no review policy found');
  process.exit(0);
}

console.log(sections.join('\n\n'));

#!/usr/bin/env node
// Usage: node post-review.js <PR> <json-file>
'use strict';

const { spawnSync } = require('child_process');

const USAGE = `post-review.js — レビュー結果(JSON)を GitHub PR レビューとして投稿する

Usage: node post-review.js <PR> <json-file>

Arguments:
  <PR>         投稿先の PR 番号
  <json-file>  GitHub の pulls/{pr}/reviews API に渡す JSON ファイルのパス

リポジトリは gh repo view から自動解決する。`;

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}
const [pr, file] = argv;

if (!pr || !file) {
  console.error(USAGE);
  process.exit(1);
}

const repo = spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
  { encoding: 'utf8' }).stdout.trim();

if (!repo) {
  console.error('Error: could not determine repo from gh repo view');
  process.exit(1);
}

const result = spawnSync('gh', ['api', `repos/${repo}/pulls/${pr}/reviews`, '--input', file],
  { encoding: 'utf8', stdio: 'inherit' });

process.exit(result.status ?? 0);

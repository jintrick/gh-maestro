#!/usr/bin/env node
// Usage: node post-review.js <PR> <json-file>
'use strict';

const { spawnSync } = require('child_process');
const [,, pr, file] = process.argv;

if (!pr || !file) {
  console.error('Usage: post-review.js <PR> <json-file>');
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

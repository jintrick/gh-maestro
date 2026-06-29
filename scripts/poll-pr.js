#!/usr/bin/env node
// Usage: node poll-pr.js <ISSUE> [INTERVAL_SECONDS]
// Polls until a PR for the given issue is found, then prints PR_DETECTED:<number>
'use strict';

const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const [,, issue, intervalArg] = process.argv;
const interval = parseInt(intervalArg || '30') * 1000;

if (!issue) {
  console.error('Usage: poll-pr.js <ISSUE> [INTERVAL_SECONDS]');
  process.exit(1);
}

const repo = spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
  { encoding: 'utf8' }).stdout.trim();

function findPR() {
  let r = spawnSync('gh', ['pr', 'list', '--repo', repo,
    '--search', `head:issue-${issue}`, '--state', 'open',
    '--json', 'number', '-q', '.[0].number'], { encoding: 'utf8' });
  const pr = r.stdout.trim();
  if (pr) return pr;

  r = spawnSync('gh', ['pr', 'list', '--repo', repo, '--state', 'open',
    '--json', 'number,body', '-q',
    `.[] | select(.body | strings | contains("#${issue}")) | .number`],
    { encoding: 'utf8' });
  return r.stdout.trim().split('\n').find(s => s.trim()) || '';
}

(async () => {
  while (true) {
    const pr = findPR();
    if (pr) {
      const workspace = process.cwd();
      const ghDir = path.join(workspace, '.gh-maestro');
      const lockFile = path.join(ghDir, `review-${pr}.running`);
      fs.mkdirSync(ghDir, { recursive: true });
      if (!fs.existsSync(lockFile)) {
        fs.writeFileSync(lockFile, String(process.pid));
        const logFd = fs.openSync(path.join(ghDir, `review-${pr}.log`), 'a');
        const child = spawn('node', [path.join(__dirname, 'run-review.js'), pr, repo, workspace], {
          detached: true,
          stdio: ['ignore', logFd, logFd],
        });
        child.unref();
        fs.closeSync(logFd);
      }
      process.stdout.write(`PR_DETECTED:${pr}\n`);
      process.exit(0);
    }
    await new Promise(r => setTimeout(r, interval));
  }
})();

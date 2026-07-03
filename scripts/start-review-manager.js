#!/usr/bin/env node
'use strict';

const { spawn } = require('./child-process');
const fs = require('fs');
const path = require('path');

const USAGE = `start-review-manager.js — PRに対してReview Managerを起動する

Usage: node start-review-manager.js <PR> <REPO> <WORKSPACE>

Output:
  REVIEW_MANAGER_STARTED:<PR>
  REVIEW_MANAGER_ALREADY_RUNNING:<PR>`;

function startReviewManager(pr, repo, workspace) {
  const ghDir = path.join(workspace, '.gh-maestro');
  const lockFile = path.join(ghDir, `review-manager-${pr}.running`);
  fs.mkdirSync(ghDir, { recursive: true });

  if (fs.existsSync(lockFile)) return 'REVIEW_MANAGER_ALREADY_RUNNING';

  fs.writeFileSync(lockFile, String(process.pid));
  const logFd = fs.openSync(path.join(ghDir, `review-manager-${pr}.log`), 'a');
  const child = spawn(process.execPath, [
    path.join(__dirname, 'run-review-manager.js'),
    pr,
    repo,
    workspace,
  ], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.on('error', () => { try { fs.unlinkSync(lockFile); } catch {} });
  child.on('exit', () => { try { fs.unlinkSync(lockFile); } catch {} });
  child.unref();
  fs.closeSync(logFd);
  return 'REVIEW_MANAGER_STARTED';
}

module.exports = { startReviewManager };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }
  const [pr, repo, workspace] = args;
  if (!pr || !repo || !workspace) {
    console.error(USAGE);
    process.exit(1);
  }
  process.stdout.write(`${startReviewManager(pr, repo, workspace)}:${pr}\n`);
}

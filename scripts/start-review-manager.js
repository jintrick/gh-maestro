#!/usr/bin/env node
'use strict';

const { spawn } = require('./child-process');
const fs = require('fs');
const path = require('path');
const { isProcessAlive } = require('./process-lifecycle');

const USAGE = `start-review-manager.js — PRに対してReview Managerを起動する

Usage: node start-review-manager.js <PR> <REPO> <WORKSPACE>

Output:
  REVIEW_MANAGER_STARTED:<PR>
  REVIEW_MANAGER_ALREADY_RUNNING:<PR>`;

/**
 * lock ファイルが有効かチェックする。
 * lock ファイルに記録されたPIDが生存していれば true（既に起動済み）。
 * PIDが死んでいる（stale）場合は lock ファイルを削除して false を返す。
 *
 * req.13: lock に PID を記録し、生存＋同一性確認で stale 判定
 *
 * @param {string} lockFile
 * @returns {boolean} true = 有効なlock（既に起動済み）, false = stale または lock なし
 */
function isLockValid(lockFile) {
  if (!fs.existsSync(lockFile)) return false;

  let lockPid;
  try {
    const raw = fs.readFileSync(lockFile, 'utf8').trim();
    lockPid = parseInt(raw, 10);
  } catch {
    // lock ファイル破損 → stale 扱い
    try { fs.unlinkSync(lockFile); } catch {}
    return false;
  }

  if (!Number.isFinite(lockPid) || lockPid <= 0) {
    try { fs.unlinkSync(lockFile); } catch {}
    return false;
  }

  if (isProcessAlive(lockPid)) return true;

  // プロセスは死んでいる → stale lock
  try { fs.unlinkSync(lockFile); } catch {}
  return false;
}

function startReviewManager(pr, repo, workspace) {
  const ghDir = path.join(workspace, '.gh-maestro');
  const lockFile = path.join(ghDir, `review-manager-${pr}.running`);
  fs.mkdirSync(ghDir, { recursive: true });

  // req.13: stale 判定付きで lock チェック
  if (isLockValid(lockFile)) return 'REVIEW_MANAGER_ALREADY_RUNNING';

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

module.exports = { startReviewManager, isLockValid };

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

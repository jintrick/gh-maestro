#!/usr/bin/env node
'use strict';

const { spawn } = require('./child-process');
const fs = require('fs');
const path = require('path');
const { isProcessAlive } = require('./process-lifecycle');
const { assertValidPr, reviewArtifactPath } = require('./shared/review-manager-paths');
const { parseFlags, hasHelpFlag } = require('./shared/workspace');

const USAGE = `start-review-manager.js — PRに対してReview Managerを起動する

Usage: node start-review-manager.js <PR> <REPO> <WORKSPACE>

Review Managerは3幹（Correctness/Resilience & Security/Maintainability）全てについて
独立したサブエージェントを並列に起動し、全観点でレビューする（観点を絞り込む判断は
Review Manager自身がPR diffを見た上で行う。skills/gh-maestro-reviewer/SKILL.md参照）。

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

/**
 * @param {string} pr
 * @param {string} repo
 * @param {string} workspace
 */
function startReviewManager(pr, repo, workspace) {
  // 副作用（lock書き込み）の前に入力を検証する（fail-closed）。
  // pr はファイルパス構成要素として使われるため、厳密な正整数であることを
  // ここで確定させる（PR #84 Review指摘: pathトラバーサル対策）。
  assertValidPr(pr);

  const ghDir = path.join(workspace, '.gh-maestro');
  fs.mkdirSync(ghDir, { recursive: true });
  const lockFile = reviewArtifactPath(ghDir, pr, '.running');

  // req.13: stale 判定付きで lock チェック
  if (isLockValid(lockFile)) return 'REVIEW_MANAGER_ALREADY_RUNNING';

  fs.writeFileSync(lockFile, String(process.pid));
  const logFd = fs.openSync(reviewArtifactPath(ghDir, pr, '.log'), 'a');
  const childArgs = [path.join(__dirname, 'run-review-manager.js'), pr, repo, workspace];
  const child = spawn(process.execPath, childArgs, {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
  });
  // spawn失敗・子プロセス終了のどちらでも lock を解放する。
  const releaseArtifacts = () => {
    try { fs.unlinkSync(lockFile); } catch {}
  };
  child.on('error', releaseArtifacts);
  child.on('exit', releaseArtifacts);
  child.unref();
  fs.closeSync(logFd);
  return 'REVIEW_MANAGER_STARTED';
}

module.exports = { startReviewManager, isLockValid };

if (require.main === module) {
  const args = process.argv.slice(2);
  const { rest, exitFlagMiss } = parseFlags(args, []);

  // exitFlagMiss（値欠落）を先に判定する。未消費の値トークンが rest に残るため、
  // それがたまたま "--help" と一致すると後段の hasHelpFlag が誤検出しうる。
  // 値欠落は常にエラー優先（フェイルクローズ）とする。
  if (exitFlagMiss) {
    console.error(USAGE);
    process.exit(1);
  }

  if (hasHelpFlag(rest)) {
    console.log(USAGE);
    process.exit(0);
  }

  const [pr, repo, workspace] = rest;
  if (!pr || !repo || !workspace || rest.length > 3) {
    console.error(USAGE);
    process.exit(1);
  }

  try {
    process.stdout.write(`${startReviewManager(pr, repo, workspace)}:${pr}\n`);
  } catch (e) {
    console.error(`start-review-manager: ${e.message}`);
    process.exit(1);
  }
}

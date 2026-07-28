#!/usr/bin/env node
'use strict';

const { spawn } = require('./child-process');
const fs = require('fs');
const path = require('path');
let _isProcessAlive = require('./process-lifecycle').isProcessAlive;
const { assertValidPr, reviewArtifactPath } = require('./shared/review-manager-paths');
const { parseFlags, hasHelpFlag } = require('./shared/workspace');

// 起動直後の即時クラッシュ（ENOENTでのspawn失敗等）を検出するための猶予（ms）。
// 呼び出し元（poll-pr.js）はこの直後、poll-reviews.jsをspawnSyncでブロッキング起動するため、
// detachedな子プロセスの非同期 exit/error イベントはその間ずっと処理されない
// （spawnSyncはイベントループを完全にブロックする。実機確認済み）。イベントに頼らず、
// 短い猶予の後に同期的に生存確認する（inbox-supervisor.js の resume 直後生存確認と同じ
// パターン。実障害: Review Managerにpwsh関数エージェント等で即時クラッシュが起きても、
// PR #171修正前はロック解放も含め一切のフィードバックがオーケストレーターへ届かなかった）。
//
// run-review-manager.js は実際のエージェント spawn の前に専用worktreeを作る（git worktree
// add + node_modules リンク）。実機確認では通常サイズのこのリポジトリで約2.2秒かかり、
// 2000msでは短すぎてクラッシュ検出前にタイムアウトした（実測）。worktree構築時間 + 直後の
// エージェントspawn失敗を両方カバーできるよう余裕を持たせる。成功時の遅延コストは
// レビュー全体（数分オーダー）に対して無視できる。
const STARTUP_LIVENESS_GRACE_MS = 8000;

const USAGE = `start-review-manager.js — PRに対してReview Managerを起動する

Usage: node start-review-manager.js <PR> <REPO> <WORKSPACE>

Review Managerは3幹（Correctness/Resilience & Security/Maintainability）全てについて
独立したサブエージェントを並列に起動し、全観点でレビューする（観点を絞り込む判断は
Review Manager自身がPR diffを見た上で行う。skills/gh-maestro-reviewer/SKILL.md参照）。

Output:
  REVIEW_MANAGER_STARTED:<PR>
  REVIEW_MANAGER_ALREADY_RUNNING:<PR>
  REVIEW_MANAGER_CRASHED:<PR>           起動直後（${STARTUP_LIVENESS_GRACE_MS}ms の猶予時間内）に
                                        プロセスが終了した（エージェントCLI起動失敗等）`;

let _sleep = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

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

  if (_isProcessAlive(lockPid)) return true;

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
  const logFile = reviewArtifactPath(ghDir, pr, '.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const logFd = fs.openSync(logFile, 'a');
  const childArgs = [path.join(__dirname, 'run-review-manager.js'), pr, repo, workspace];
  const child = spawn(process.execPath, childArgs, {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
  });
  // spawn失敗・子プロセス終了のどちらでも lock を解放する。
  // 注意: 呼び出し元（poll-pr.js）はこの関数の直後に poll-reviews.js を spawnSync で
  // ブロッキング起動するため、この 'error'/'exit' イベント自体は実質的に発火のタイミングを
  // 保証されない（イベントループがブロックされている間は処理されない）。ロック解放の
  // 最終的な保険として登録するが、起動直後クラッシュの検出は下記の同期的な生存確認に頼る。
  const releaseArtifacts = () => {
    try { fs.unlinkSync(lockFile); } catch {}
  };
  child.on('error', releaseArtifacts);
  child.on('exit', releaseArtifacts);
  child.unref();
  fs.closeSync(logFd);

  if (!child.pid) {
    releaseArtifacts();
    return 'REVIEW_MANAGER_CRASHED';
  }

  // 起動直後クラッシュ（ENOENT等）の検出。short-graceの後に同期的に生存確認する
  // （このモジュール冒頭のSTARTUP_LIVENESS_GRACE_MSコメント参照）。
  _sleep(STARTUP_LIVENESS_GRACE_MS);
  if (!_isProcessAlive(child.pid)) {
    releaseArtifacts();
    return 'REVIEW_MANAGER_CRASHED';
  }

  return 'REVIEW_MANAGER_STARTED';
}

module.exports = {
  startReviewManager,
  isLockValid,
  _setSleep: (fn) => { _sleep = fn; },
  _setIsProcessAlive: (fn) => { _isProcessAlive = fn; },
  STARTUP_LIVENESS_GRACE_MS,
};

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

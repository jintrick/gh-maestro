'use strict';
// git-worktree.js
// git worktree 操作の共有ヘルパー
// Windows の MAX_PATH (260 文字) 制限を回避するため、
// 全操作に -c core.longpaths=true を適用する。
//
// 使用箇所: spawn-worker.js, remove-worker.js, reset-session.js

const { execSync } = require('child_process');

/**
 * git worktree add — worktree を作成する
 * @param {string} worktreeDir - worktree の絶対パス
 * @param {string} branchName  - 作成するブランチ名
 * @param {string|null} baseRef - ベースブランチ（例: "dev"）。null の場合は HEAD から分岐
 * @param {string} cwd - 実行ディレクトリ（リポジトリルート）
 * @returns {Buffer|string} execSync の戻り値
 */
function worktreeAdd(worktreeDir, branchName, baseRef, cwd) {
  const refPart = baseRef ? ` origin/${baseRef}` : '';
  return execSync(
    `git -c core.longpaths=true worktree add "${worktreeDir}" -b "${branchName}"${refPart}`,
    { cwd, stdio: 'inherit', windowsHide: true }
  );
}

/**
 * git worktree remove — worktree を削除する
 * @param {string} worktreeDir - worktree の絶対パス
 * @param {string} cwd - 実行ディレクトリ（リポジトリルート）
 * @param {object} [opts]
 * @param {boolean} [opts.doubleForce=false] - true で --force --force を付与
 * @param {string} [opts.stdio='pipe'] - stdio モード
 * @returns {Buffer|string} execSync の戻り値
 */
function worktreeRemove(worktreeDir, cwd, opts = {}) {
  const force = opts.doubleForce ? '--force --force' : '--force';
  return execSync(
    `git -c core.longpaths=true worktree remove ${force} "${worktreeDir}"`,
    { cwd, stdio: opts.stdio || 'pipe', windowsHide: true }
  );
}

/**
 * git worktree prune — 残留 worktree メタデータを掃除する
 * @param {string} cwd - 実行ディレクトリ（リポジトリルート）
 * @param {object} [opts]
 * @param {string} [opts.stdio='pipe'] - stdio モード
 * @returns {Buffer|string} execSync の戻り値
 */
function worktreePrune(cwd, opts = {}) {
  return execSync(
    'git -c core.longpaths=true worktree prune',
    { cwd, stdio: opts.stdio || 'pipe', windowsHide: true }
  );
}

module.exports = { worktreeAdd, worktreeRemove, worktreePrune };

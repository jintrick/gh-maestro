'use strict';
// worktree-removal.js
// 作業場所（worktree）を削除する中核手順の共有関数。
//
// 手順: リンクを外して確認 → git worktree remove → 失敗時の prune と力ずくの削除。
// リンク検証の失敗（isLinkGuardError）の判定は、このファイルだけに置く（Issue #737 / #740）。
// 呼び出し元は、この関数が throw したら作業場所を残したものとして扱えばよい。
//
// 失敗の伝え方:
//   - リンクを外せたか判定できなかった（1回目の確認・git 削除内の2回目の確認の両方）→ throw。
//     git 削除・prune・力ずくの削除のどれも行わない（リンク先を保護する）。
//   - リンク以外の失敗（git 削除・prune・力ずくの削除）→ log に出して続行する。

const { existsSync, rmSync } = require('fs');
const { execSync } = require('./child-process');
const { unlinkJunctionsAndVerify, isLinkGuardError } = require('./unlink-junctions');
const { worktreeRemove: gitWorktreeRemove, worktreePrune: gitWorktreePrune } = require('./git-worktree');

const FALLBACKS = new Set(['onGitFailure', 'always', 'whenDirRemains']);
const ORDERS = new Set(['pruneFirst', 'forceFirst']);
const FORCE_REMOVERS = new Set(['rmSync', 'platform']);

/**
 * Windows で PowerShell の [System.IO.Directory]::Delete により作業場所を削除する。
 * Remove-Item -Recurse は PowerShell 5.x で junction を辿り中身を消すため使わない。
 * Directory::Delete は junction 自体だけを消し、中身を辿らない。
 * 非 Windows では何もせず false を返す。
 *
 * @param {string} dir
 * @returns {boolean} 削除後に dir が存在しなければ true
 */
function deleteDirectoryViaPowerShell(dir) {
  if (process.platform !== 'win32') return false;
  const escaped = dir.replace(/'/g, "''");
  try {
    execSync(
      `powershell -NoProfile -Command "[System.IO.Directory]::Delete('${escaped}', $true)"`,
      { stdio: 'pipe', timeout: 15000 }
    );
    return !existsSync(dir);
  } catch (_) {
    return false;
  }
}

function forceRemoveDir(dir, mode) {
  if (mode === 'platform' && process.platform === 'win32') {
    deleteDirectoryViaPowerShell(dir);
    return;
  }
  rmSync(dir, { recursive: true, force: true });
}

/**
 * 作業場所を削除する中核手順。
 *
 * @param {string} worktreeDir - 削除する作業場所の絶対パス
 * @param {string} workspace - リポジトリのルート（git の実行ディレクトリ）
 * @param {object} [options]
 * @param {'onGitFailure'|'always'|'whenDirRemains'} [options.fallback='onGitFailure']
 *   prune と力ずくの削除を行う条件。
 *   - onGitFailure: git 削除がリンク以外の理由で失敗したときだけ行う
 *   - always: git 削除の成否にかかわらず行う（作業場所が残っている場合のみ）
 *   - whenDirRemains: git 削除の後に作業場所が残っているときだけ行う
 * @param {'pruneFirst'|'forceFirst'} [options.order='pruneFirst'] - prune と力ずくの削除の順
 * @param {'rmSync'|'platform'} [options.forceRemove='rmSync'] - 力ずくの削除の手段。
 *   platform は Windows で PowerShell、それ以外で rmSync
 * @param {boolean} [options.doubleForce=false] - git worktree remove に --force --force を付ける
 * @param {(msg: string) => void} [options.log=console.warn] - リンク以外の失敗の記録先
 * @param {object} [options.deps] - テスト用の注入点。既定は実関数
 * @returns {{ removed: boolean }} 関数の終了時点で作業場所が存在しなければ removed=true
 * @throws {Error} リンクを外せたと確認できなかった（code は WORKTREE_LINKS_REMAIN / WORKTREE_LINKS_UNVERIFIABLE）
 */
function removeWorktreeWithLinkGuard(worktreeDir, workspace, options = {}) {
  const {
    fallback = 'onGitFailure',
    order = 'pruneFirst',
    forceRemove = 'rmSync',
    doubleForce = false,
    log = console.warn,
    deps = {},
  } = options;
  // 不正な指定は、削除を始める前に止める（フェイルクローズ）。
  if (!FALLBACKS.has(fallback)) throw new TypeError(`removeWorktreeWithLinkGuard: 不明な fallback: ${fallback}`);
  if (!ORDERS.has(order)) throw new TypeError(`removeWorktreeWithLinkGuard: 不明な order: ${order}`);
  if (!FORCE_REMOVERS.has(forceRemove)) throw new TypeError(`removeWorktreeWithLinkGuard: 不明な forceRemove: ${forceRemove}`);

  const unlinkFn = deps.unlinkJunctionsAndVerify || unlinkJunctionsAndVerify;
  const gitRemoveFn = deps.worktreeRemove || gitWorktreeRemove;
  const pruneFn = deps.worktreePrune || gitWorktreePrune;
  const forceFn = deps.forceRemoveFn || ((dir) => forceRemoveDir(dir, forceRemove));
  const exists = deps.existsSync || existsSync;

  // 1回目の確認。外せたと確認できなければ throw し、何も削除しない。
  unlinkFn(worktreeDir);

  // git worktree remove。内部で2回目の確認が走るため、そのリンク検証の失敗もここで throw される。
  let gitFailed = false;
  try {
    gitRemoveFn(worktreeDir, workspace, { doubleForce });
  } catch (e) {
    if (isLinkGuardError(e)) throw e;
    gitFailed = true;
    log(`git worktree remove 失敗: ${e.message.split('\n')[0]}`);
  }

  if (fallback === 'whenDirRemains' && !exists(worktreeDir)) return { removed: true };
  if (fallback === 'onGitFailure' && !gitFailed) return { removed: !exists(worktreeDir) };

  const prune = () => {
    try { pruneFn(workspace); } catch (e) { log(`git worktree prune 失敗: ${e.message.split('\n')[0]}`); }
  };
  const force = () => {
    if (!exists(worktreeDir)) return;
    try { forceFn(worktreeDir); } catch (e) { log(`力ずくの削除に失敗: ${e.message.split('\n')[0]}`); }
  };
  if (order === 'pruneFirst') {
    prune();
    force();
  } else {
    force();
    prune();
  }
  return { removed: !exists(worktreeDir) };
}

module.exports = { removeWorktreeWithLinkGuard, deleteDirectoryViaPowerShell };

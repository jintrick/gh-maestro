'use strict';
// git-worktree.js
// git worktree 操作の共有ヘルパー
// Windows の MAX_PATH (260 文字) 制限を回避するため、
// 全操作に -c core.longpaths=true を適用する。
//
// すべての git コマンドは spawnSync（引数配列）を使用し、
// シェル経由の文字列補間に伴う注入脆弱性を回避する。
//
// 使用箇所: spawn-worker.js, remove-worker.js, reset-session.js

const { spawnSync } = require('./child-process');

/**
 * コマンドを実行し、非ゼロ終了コードなら throw する。
 * execSync の throw-on-nonzero セマンティクスを spawnSync で再現する。
 */
function runOrThrow(cmd, args, opts) {
  const r = spawnSync(cmd, args, opts);
  // OSレベル失敗（ENOENT 等）は status が null になる。先に error をチェックする。
  if (r.error) {
    const err = new Error(`${cmd} ${args.join(' ')} failed: ${r.error.message}`);
    err.code = r.error.code;
    throw err;
  }
  if (r.status !== 0) {
    const err = new Error(`${cmd} ${args.join(' ')} exited with ${r.status}: ${(r.stderr || '').toString().trim()}`);
    err.status = r.status;
    err.stderr = r.stderr;
    throw err;
  }
  return r;
}

/**
 * worktree作成後にbaseRefへのupstream trackingを明示的に設定する。
 * git worktree add は branch.autoSetupMerge に依存してtrackingを設定するため、
 * これが false の環境ではtrackingが付かない。常に明示設定することでambientな
 * git設定への依存を排除する。
 *
 * @param {string} branchName - 作成したブランチ名
 * @param {string} baseRef - ベースブランチ（例: "dev"）
 * @param {string} cwd - 実行ディレクトリ（リポジトリルート）
 */
function setUpstream(branchName, baseRef, cwd) {
  runOrThrow('git',
    ['-c', 'core.longpaths=true', 'branch', '--set-upstream-to', `origin/${baseRef}`, '--', branchName],
    { cwd, stdio: 'pipe' });
}

/**
 * git worktree add — worktree を作成する
 * @param {string} worktreeDir - worktree の絶対パス
 * @param {string} branchName  - 作成するブランチ名
 * @param {string|null} baseRef - ベースブランチ（例: "dev"）。null の場合は HEAD から分岐
 * @param {string} cwd - 実行ディレクトリ（リポジトリルート）
 * @returns {import('child_process').SpawnSyncReturns<Buffer>} spawnSync の戻り値
 */
function worktreeAdd(worktreeDir, branchName, baseRef, cwd) {
  const args = ['-c', 'core.longpaths=true', 'worktree', 'add', worktreeDir, '-b', branchName];
  if (baseRef) args.push('--', `origin/${baseRef}`);
  const result = runOrThrow('git', args, { cwd, stdio: 'inherit' });
  // branch.autoSetupMerge に依存せず、常に明示的に upstream tracking を設定する
  if (baseRef) setUpstream(branchName, baseRef, cwd);
  return result;
}

/**
 * git worktree add --detach — ブランチを作らず、指定コミットを作業ツリーとして追加する。
 * council の議論用worktree（読み取り専用の逃げ道・使い捨て）が主な利用元。
 * sha はユーザー由来値になりうるため、`--` セパレータで operands を分離する
 * （git-arg-injection ルール準拠。`-` 始まりの値がオプションとして解釈されない）。
 *
 * @param {string} worktreeDir - worktree の絶対パス
 * @param {string} sha - チェックアウトするコミット
 * @param {string} cwd - 実行ディレクトリ（リポジトリルート）
 * @returns {import('child_process').SpawnSyncReturns<Buffer>} spawnSync の戻り値
 */
function worktreeAddDetached(worktreeDir, sha, cwd) {
  const args = ['-c', 'core.longpaths=true', 'worktree', 'add', '--detach', worktreeDir, '--', sha];
  return runOrThrow('git', args, { cwd, stdio: 'pipe' });
}

/**
 * git worktree remove — worktree を削除する
 * @param {string} worktreeDir - worktree の絶対パス
 * @param {string} cwd - 実行ディレクトリ（リポジトリルート）
 * @param {object} [opts]
 * @param {boolean} [opts.doubleForce=false] - true で --force --force を付与
 * @param {string} [opts.stdio='pipe'] - stdio モード
 * @returns {import('child_process').SpawnSyncReturns<Buffer>} spawnSync の戻り値
 */
function worktreeRemove(worktreeDir, cwd, opts = {}) {
  const forceArgs = opts.doubleForce ? ['--force', '--force'] : ['--force'];
  const args = ['-c', 'core.longpaths=true', 'worktree', 'remove', ...forceArgs, worktreeDir];
  return runOrThrow('git', args, { cwd, stdio: opts.stdio || 'pipe' });
}

/**
 * git worktree prune — 残留 worktree メタデータを掃除する
 * @param {string} cwd - 実行ディレクトリ（リポジトリルート）
 * @param {object} [opts]
 * @param {string} [opts.stdio='pipe'] - stdio モード
 * @returns {import('child_process').SpawnSyncReturns<Buffer>} spawnSync の戻り値
 */
function worktreePrune(cwd, opts = {}) {
  const args = ['-c', 'core.longpaths=true', 'worktree', 'prune'];
  return runOrThrow('git', args, { cwd, stdio: opts.stdio || 'pipe' });
}

module.exports = { worktreeAdd, worktreeAddDetached, worktreeRemove, worktreePrune };

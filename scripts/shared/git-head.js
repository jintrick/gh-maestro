'use strict';
// git-head.js — リポジトリの HEAD コミットSHA 解決の共有ヘルパー。
// council-worktree.js の resolveWorkspaceHead から抽出し、worktree など任意のディレクトリの
// HEAD 解決に再利用できるようにする（Issue #374）。push-and-declare.js は worktree の HEAD を
// 解決するために使う。council-worktree.js はこの実装へ委譲する。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const { spawnSync } = require('../child-process');

const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * 指定ディレクトリの HEAD コミットを取得する。失敗時は throw。
 * @param {string} dir リポジトリルート（main worktree または作業用 worktree）
 * @returns {string} 40桁の sha
 */
function resolveGitHead(dir) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    throw new Error(`git rev-parse HEAD failed: ${(r.stderr || '').toString().trim() || (r.error && r.error.message) || 'unknown error'}`);
  }
  const sha = String(r.stdout || '').trim();
  if (!SHA_RE.test(sha)) {
    throw new Error(`git rev-parse HEAD returned unexpected value: ${JSON.stringify(sha)}`);
  }
  return sha;
}

module.exports = { resolveGitHead, SHA_RE };

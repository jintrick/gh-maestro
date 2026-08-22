'use strict';
// git-branch.js — リポジトリの現在のブランチ名取得の共有ヘルパー（Issue #378）。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

let _spawnSync = require('./child-process').spawnSync;

/**
 * 指定ディレクトリの現在のブランチ名を取得する。
 *
 * - 成功時（ブランチ上にいる場合）: トリムされたブランチ名文字列を返す。
 * - detached HEAD 時（ブランチ上にいない場合）: 空文字列 '' を返す。
 * - git コマンド実行失敗時（git リポジトリ外、git コマンド不在など）: 例外を throw する。
 *
 * @param {string} dir リポジトリルートまたは worktree パス
 * @returns {string} ブランチ名（detached HEAD 時は ''）
 * @throws {Error} git コマンドの実行に失敗した場合
 */
function getCurrentBranch(dir) {
  if (!dir || typeof dir !== 'string') {
    throw new Error(`getCurrentBranch: 有効なディレクトリパスが必要です（指定値: ${JSON.stringify(dir)}）`);
  }

  const r = _spawnSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    const detail = (r.stderr || '').toString().trim() || (r.error && r.error.message) || 'unknown error';
    throw new Error(`git branch --show-current failed: ${detail}`);
  }

  return String(r.stdout || '').trim();
}

module.exports = {
  getCurrentBranch,
  _setSpawnSync: (fn) => { _spawnSync = fn; },
};

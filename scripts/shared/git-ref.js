'use strict';
// git-ref.js — fetch済みのrefからファイルを読み取る非破壊ヘルパー
//
// 遺物検査はネットワークへ出ない。refの存在確認とref内ファイルの読み取りを
// `git show` だけで行い、未取得ref・読み取り失敗・対象ファイル不在を呼び出し側が
// 区別できる形で返す。fetchやremote APIはこのモジュールの責務に含めない。

const { spawnSync } = require('./child-process');

const MISSING_PATH_RE = /(?:does not exist|exists on disk, but not in|path .* does not exist)/i;

function runGit(args, cwd, spawnSyncFn) {
  let result;
  try {
    result = spawnSyncFn('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (error) {
    return { status: 'unknown', error: error.message };
  }
  if (!result || result.error || result.status === null || result.status === undefined) {
    return {
      status: 'unknown',
      error: result?.error?.message || 'git process did not provide an exit status',
    };
  }
  return {
    status: result.status === 0 ? 'ok' : 'failed',
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    exitCode: result.status,
  };
}

/**
 * fetch済みのref内にあるファイルを読み取る。
 *
 * @param {string} cwd リポジトリのルート
 * @param {string} ref 検証済みまたはローカルに存在するref
 * @param {string} filePath ref内の相対ファイルパス
 * @param {{spawnSyncFn?: Function}} [options]
 * @returns {{status:'present'|'absent'|'unknown', content?:string, reason?:string}}
 */
function readFileAtRef(cwd, ref, filePath, { spawnSyncFn = spawnSync } = {}) {
  const refResult = runGit(['show', '--quiet', '--format=%H', ref], cwd, spawnSyncFn);
  if (refResult.status !== 'ok') {
    return {
      status: 'unknown',
      reason: `ref ${ref} を読み取れません: ${refResult.error || refResult.stderr.trim() || `exit ${refResult.exitCode}`}`,
    };
  }

  const fileResult = runGit(['show', `${ref}:${filePath}`], cwd, spawnSyncFn);
  if (fileResult.status === 'ok') {
    return { status: 'present', content: fileResult.stdout };
  }

  if (fileResult.status === 'failed' && MISSING_PATH_RE.test(fileResult.stderr)) {
    return { status: 'absent', reason: `${ref}:${filePath} is not present` };
  }

  return {
    status: 'unknown',
    reason: `${ref}:${filePath} の読み取りに失敗しました: ${fileResult.stderr.trim() || `exit ${fileResult.exitCode}`}`,
  };
}

module.exports = { readFileAtRef };

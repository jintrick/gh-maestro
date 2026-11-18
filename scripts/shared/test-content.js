'use strict';

// test-content.js — テスト実行対象と申告対象コミットの内容を比較する共有ヘルパー。
//
// テストはコミット前の worktree で実行される。したがって、テスト時の HEAD と
// push-and-declare.js が後から作るコミットの SHA は一致しないことが正常である。
// ここでは各パスを Git が保存する blob の object ID へ正規化し、パスと object ID の
// 決定論的な SHA-256 を内容の指紋として使う。テスト後にファイルを変更してから
// コミットした場合は、コミットの tree から作った指紋と一致しないため、申告側は
// fail/pass を実行元の記録として採用せず unknown へ縮退する。

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('./child-process');
const { parseTreeEntries, normalizeGitPath, OBJECT_ID_RE } = require('./git-ref');

const CONTENT_HASH_VERSION = 'git-blob-snapshot-v1';

function gitError(args, result) {
  const stderr = String(result && result.stderr || '').trim();
  const detail = stderr || (result && result.error && result.error.message) || 'unknown error';
  return new Error(`git ${args.join(' ')} failed: ${detail}`);
}

function runGit(worktree, args, options = {}, spawnSyncFn = spawnSync) {
  const result = spawnSyncFn('git', args, {
    cwd: worktree,
    encoding: 'utf8',
    ...options,
  });
  if (!result || result.error || result.status !== 0) throw gitError(args, result);
  return String(result.stdout || '');
}

function hashEntries(entries) {
  const normalized = entries.map(({ path, objectId }) => ({
    path: normalizeGitPath(path),
    objectId: String(objectId).toLowerCase(),
  }));
  normalized.sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));

  const hash = crypto.createHash('sha256');
  hash.update(`${CONTENT_HASH_VERSION}\0`, 'utf8');
  for (const entry of normalized) {
    const pathBytes = Buffer.from(entry.path, 'utf8');
    hash.update(String(pathBytes.length), 'ascii');
    hash.update('\0', 'ascii');
    hash.update(pathBytes);
    hash.update('\0', 'ascii');
    hash.update(entry.objectId, 'ascii');
    hash.update('\0', 'ascii');
  }
  return hash.digest('hex');
}

function parseNulPaths(output) {
  return output.split('\0').filter(Boolean).map(normalizeGitPath);
}

function uniqueExistingFiles(worktree, paths) {
  const result = [];
  const seen = new Set();
  for (const relativePath of paths) {
    if (seen.has(relativePath)) continue;
    seen.add(relativePath);
    // Git pathnames containing a newline cannot be passed through the
    // newline-delimited hash-object --stdin-paths interface safely. Fail closed
    // instead of silently hashing a different path.
    if (/[\r\n]/.test(relativePath)) {
      throw new Error(`unsupported newline in Git path: ${JSON.stringify(relativePath)}`);
    }
    const absolutePath = path.join(worktree, ...relativePath.split('/'));
    let stat;
    try {
      stat = fs.lstatSync(absolutePath);
    } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      throw error;
    }
    // Deleted files are absent from the tree that git add -A will create.
    // Directories are not blob contents; their children are listed separately.
    if (stat.isFile() || stat.isSymbolicLink()) result.push(relativePath);
  }
  return result;
}

/**
 * worktree の現在の Git 対象ファイルを、Git blob object ID の集合として指紋化する。
 * tracked file と、git add -A で拾われる ignored でない untracked file を対象にし、
 * 削除済み tracked file と ignored runtime/node_modules は対象から外す。
 *
 * @param {string} worktree
 * @param {object} [options]
 * @param {Function} [options.spawnSyncFn] テスト用の git 呼び出し差し替え
 * @returns {string} 64桁 SHA-256
 */
function calculateWorktreeContentHash(worktree, { spawnSyncFn = spawnSync } = {}) {
  const pathOutput = runGit(
    worktree,
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {},
    spawnSyncFn,
  );
  const paths = uniqueExistingFiles(worktree, parseNulPaths(pathOutput));
  if (paths.length === 0) return hashEntries([]);

  const objectOutput = runGit(
    worktree,
    ['hash-object', '--stdin-paths'],
    { input: `${paths.join('\n')}\n` },
    spawnSyncFn,
  );
  const objectIds = objectOutput.trim().split(/\r?\n/).filter(Boolean);
  if (objectIds.length !== paths.length || objectIds.some(id => !OBJECT_ID_RE.test(id))) {
    throw new Error('git hash-object returned an unexpected number or form of object IDs');
  }
  return hashEntries(paths.map((path, index) => ({ path, objectId: objectIds[index] })));
}

/**
 * 指定コミットの tree を worktree 指紋と同じ形式で指紋化する。
 * commit は呼び出し側で SHA 形式を検証済みであることを前提にする。
 *
 * @param {string} worktree
 * @param {string} commit
 * @param {object} [options]
 * @param {Function} [options.spawnSyncFn] テスト用の git 呼び出し差し替え
 * @returns {string} 64桁 SHA-256
 */
function calculateCommitContentHash(worktree, commit, { spawnSyncFn = spawnSync } = {}) {
  const treeOutput = runGit(
    worktree,
    ['ls-tree', '-r', '-z', '--full-tree', commit],
    {},
    spawnSyncFn,
  );
  return hashEntries(parseTreeEntries(treeOutput));
}

module.exports = {
  CONTENT_HASH_VERSION,
  hashEntries,
  calculateWorktreeContentHash,
  calculateCommitContentHash,
};

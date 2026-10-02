'use strict';

// freshness-status.js — セッション開始時に、ローカルの基準とGitHub上の同名
// ブランチの鮮度を事実として確認する。確認できない場合はunknownを返し、呼び出し側
// がセッション開始を継続できるようにする。

const path = require('path');
const { spawnSync } = require('./child-process');
const { SHA_RE } = require('./git-head');
const { JsonFileError, readJsonFile } = require('./json-file');
const { managedRoot } = require('./storage-layout');

const INSTALL_SOURCE_FILENAME = 'install-source.json';
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[^\s\u0000-\u001f\u007f]+$/;

function cleanReason(reason) {
  const value = reason instanceof Error ? reason.message : String(reason || '原因不明');
  return value.replace(/[\r\n]+/g, ' ').trim() || '原因不明';
}

function unknownStatus(reason) {
  return { status: 'unknown', reason: cleanReason(reason) };
}

function validateRepository(value, label = 'リポジトリ') {
  if (typeof value !== 'string' || !REPOSITORY_RE.test(value)) {
    throw new Error(`${label}がowner/repo形式ではありません: ${JSON.stringify(value)}`);
  }
  return value;
}

function validateBranch(value, label = 'ブランチ') {
  if (typeof value !== 'string' || value.length === 0 || !BRANCH_RE.test(value)) {
    throw new Error(`${label}が不正です: ${JSON.stringify(value)}`);
  }
  return value;
}

function validateCommit(value, label = 'コミット') {
  if (typeof value !== 'string' || !SHA_RE.test(value)) {
    throw new Error(`${label}が40桁のSHAではありません: ${JSON.stringify(value)}`);
  }
  return value.toLowerCase();
}

function encodePathSegment(value) {
  return encodeURIComponent(value);
}

function runGhApi(args, options = {}) {
  const spawnSyncFn = options.spawnSyncFn || spawnSync;
  const result = spawnSyncFn('gh', args, {
    cwd: options.workspace,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: options.timeoutMs === undefined ? 10000 : options.timeoutMs,
  });
  if (result && (result.error || result.status !== 0)) {
    const detail = String((result && result.stderr) || '').trim()
      || (result && result.error && result.error.message)
      || `終了コード ${result && result.status}`;
    throw new Error(`gh api に失敗しました: ${detail}`);
  }
  return String((result && result.stdout) || '').trim();
}

function remoteBranchHead(repository, branch, options = {}) {
  validateRepository(repository, 'GitHubリポジトリ');
  validateBranch(branch, 'GitHubブランチ');
  const cache = options.remoteHeadCache || new Map();
  const key = `${repository}\u0000${branch}`;
  if (cache.has(key)) return cache.get(key);

  const output = runGhApi([
    'api',
    `repos/${repository}/branches/${encodePathSegment(branch)}`,
    '--jq',
    '.commit.sha',
  ], options);
  const head = validateCommit(output, `GitHubブランチ ${repository}:${branch} のHEAD`);
  cache.set(key, head);
  return head;
}

function compareBehind(repository, localCommit, remoteCommit, options = {}) {
  validateRepository(repository, 'GitHubリポジトリ');
  const local = validateCommit(localCommit, '比較元コミット');
  const remote = validateCommit(remoteCommit, '比較先コミット');
  const output = runGhApi([
    'api',
    `repos/${repository}/compare/${local}...${remote}`,
    '--jq',
    '.behind_by',
  ], options);
  if (!/^\d+$/.test(output)) {
    throw new Error(`GitHub compare APIのbehind_byが整数ではありません: ${JSON.stringify(output)}`);
  }
  const behind = Number(output);
  if (!Number.isSafeInteger(behind)) {
    throw new Error(`GitHub compare APIのbehind_byが範囲外です: ${JSON.stringify(output)}`);
  }
  return behind;
}

function validateInstallSourceRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('install-source.jsonのトップレベルがオブジェクトではありません');
  }
  if (value.schemaVersion !== 1) {
    throw new Error(`install-source.jsonのschemaVersionが1ではありません: ${JSON.stringify(value.schemaVersion)}`);
  }
  const sourceRepository = validateRepository(value.sourceRepository, 'install-source.jsonのsourceRepository');
  const sourceBranch = validateBranch(value.sourceBranch, 'install-source.jsonのsourceBranch');
  const sourceCommit = validateCommit(value.sourceCommit, 'install-source.jsonのsourceCommit');
  return {
    ...value,
    schemaVersion: 1,
    sourceRepository,
    sourceBranch,
    sourceCommit,
  };
}

function readInstallSource(recordPath = path.join(managedRoot(), INSTALL_SOURCE_FILENAME), options = {}) {
  const readJsonFileFn = options.readJsonFileFn || readJsonFile;
  try {
    return { status: 'ok', record: validateInstallSourceRecord(readJsonFileFn(recordPath)) };
  } catch (error) {
    if (error instanceof JsonFileError) {
      if (error.kind === 'read' && error.code === 'ENOENT') {
        return { status: 'absent', reason: `${recordPath} がありません` };
      }
      if (error.kind === 'parse') {
        return { status: 'unknown', reason: `${recordPath} のJSON構文エラー: ${cleanReason(error)}` };
      }
      if (error.kind === 'read') {
        return { status: 'unknown', reason: `${recordPath} の読み取りに失敗しました: ${cleanReason(error)}` };
      }
    }
    return { status: 'unknown', reason: `${recordPath} の形式が不正です: ${cleanReason(error)}` };
  }
}

function inspectBranchFreshness(options, cache) {
  try {
    const repository = validateRepository(options.repository, 'originリポジトリ');
    const branch = validateBranch(options.baseBranch, 'BASE_BRANCH');
    const localHead = validateCommit(options.localHead, 'ローカルHEAD');
    const remoteHead = remoteBranchHead(repository, branch, {
      ...options,
      remoteHeadCache: cache,
    });
    const behindCommits = compareBehind(repository, localHead, remoteHead, options);
    if (behindCommits > 0) {
      return { status: 'behind', behindCommits, remoteCommit: remoteHead };
    }
    return { status: 'up-to-date', remoteCommit: remoteHead };
  } catch (error) {
    return unknownStatus(error);
  }
}

function inspectInstallFreshness(options, cache) {
  const recordPath = options.recordPath || path.join(managedRoot(), INSTALL_SOURCE_FILENAME);
  const source = readInstallSource(recordPath, options);
  if (source.status !== 'ok') return unknownStatus(source.reason);

  try {
    const record = source.record;
    const remoteHead = remoteBranchHead(record.sourceRepository, record.sourceBranch, {
      ...options,
      remoteHeadCache: cache,
    });
    const behindCommits = compareBehind(record.sourceRepository, record.sourceCommit, remoteHead, options);
    return {
      status: behindCommits > 0 ? 'stale' : 'up-to-date',
      behindCommits,
      sourceRepository: record.sourceRepository,
      sourceBranch: record.sourceBranch,
      installedCommit: record.sourceCommit,
      remoteCommit: remoteHead,
    };
  } catch (error) {
    return unknownStatus(error);
  }
}

function inspectFreshness(options = {}) {
  const cache = options.remoteHeadCache || new Map();
  return {
    baseBranch: inspectBranchFreshness(options, cache),
    install: inspectInstallFreshness(options, cache),
  };
}

function formatBaseBranchStatus(status) {
  if (status && status.status === 'behind') {
    return `BASE_BRANCH_STATUS=behind BEHIND_COMMITS=${status.behindCommits}`;
  }
  if (status && status.status === 'up-to-date') return 'BASE_BRANCH_STATUS=up-to-date';
  return `BASE_BRANCH_STATUS=unknown REASON=${cleanReason(status && status.reason)}`;
}

function formatInstallStatus(status) {
  if (status && (status.status === 'stale' || status.status === 'up-to-date')) {
    const fields = [
      `SOURCE_REPOSITORY=${status.sourceRepository}`,
      `SOURCE_BRANCH=${status.sourceBranch}`,
      `INSTALLED_COMMIT=${status.installedCommit}`,
    ];
    if (status.status === 'stale') fields.push(`BEHIND_COMMITS=${status.behindCommits}`);
    return `GH_MAESTRO_INSTALL_STATUS=${status.status} ${fields.join(' ')}`;
  }
  return `GH_MAESTRO_INSTALL_STATUS=unknown REASON=${cleanReason(status && status.reason)}`;
}

module.exports = {
  INSTALL_SOURCE_FILENAME,
  REPOSITORY_RE,
  validateRepository,
  validateBranch,
  validateCommit,
  runGhApi,
  remoteBranchHead,
  compareBehind,
  validateInstallSourceRecord,
  readInstallSource,
  inspectFreshness,
  formatBaseBranchStatus,
  formatInstallStatus,
  cleanReason,
};

'use strict';

// legacy-cleanup.js — 台帳のcleanupIdから明示的なレガシー整理を実行する。
//
// 検出経路とは別の明示的な入口であり、検出時に自動実行しない。今回扱う
// status-paneの旧形式は接続先を持たないため、記録ファイルだけを削除し、
// paneIdを使ったWezTerm操作は行わない。

const fs = require('fs');
const { CATALOG } = require('./legacy-catalog');
const processLifecycle = require('../process-lifecycle');
const {
  statusPaneRecordPath,
  classifyStatusPaneRecord,
} = require('./status-pane-legacy');

const STATUS_PANE_CLEANUP_ID = 'cleanup-legacy.statusPaneRecord';
const STATUS_PANE_LOCK_SCRIPT = 'status-pane';
const STATUS_PANE_LOCK_WORKER = null;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function catalogEntryForCleanupId(cleanupId, catalog = CATALOG) {
  if (!Array.isArray(catalog)) return null;
  return catalog.find((entry) => entry && entry.cleanupId === cleanupId) || null;
}

function unsupported(cleanupId, reason) {
  return {
    ok: false,
    status: 'unsupported',
    cleanupId,
    reason,
  };
}

function readStatusPaneRecord(filePath, readFileFn) {
  let raw;
  try {
    raw = readFileFn(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { state: 'missing' };
    return { state: 'unknown', reason: filePath + ' の読み取りに失敗しました: ' + errorMessage(error) };
  }

  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return { state: 'unknown', reason: filePath + ' のJSON構文エラー: ' + errorMessage(error) };
  }

  const classification = classifyStatusPaneRecord(value);
  return {
    state: classification.status,
    ...(classification.reason ? { reason: classification.reason } : {}),
  };
}

function defaultAcquireLock(workspace) {
  return processLifecycle.acquireStartupLock(
    workspace,
    STATUS_PANE_LOCK_SCRIPT,
    STATUS_PANE_LOCK_WORKER,
  );
}

function defaultReleaseLock(workspace) {
  return processLifecycle.releaseStartupLock(
    workspace,
    STATUS_PANE_LOCK_SCRIPT,
    STATUS_PANE_LOCK_WORKER,
  );
}

function cleanupStatusPaneRecord(options = {}) {
  const {
    cleanupId = STATUS_PANE_CLEANUP_ID,
    workspace,
    runtimeRoot,
    acquireLockFn = defaultAcquireLock,
    releaseLockFn = defaultReleaseLock,
    readFileFn = fs.readFileSync,
    unlinkFn = fs.unlinkSync,
  } = options;

  const filePath = statusPaneRecordPath(workspace, runtimeRoot);
  let locked = false;
  try {
    let acquired;
    try {
      acquired = acquireLockFn(workspace);
    } catch (error) {
      return {
        ok: false,
        status: 'unknown',
        cleanupId,
        path: filePath,
        reason: 'status-paneのロック取得に失敗しました: ' + errorMessage(error),
      };
    }
    if (typeof acquired !== 'boolean' || !acquired) {
      return {
        ok: false,
        status: 'unknown',
        cleanupId,
        path: filePath,
        reason: 'status-paneのロックを取得できませんでした',
      };
    }
    locked = true;

    const record = readStatusPaneRecord(filePath, readFileFn);
    if (record.state === 'missing') {
      return { ok: true, status: 'absent', cleanupId, path: filePath };
    }
    if (record.state === 'unknown') {
      return {
        ok: false,
        status: 'unknown',
        cleanupId,
        path: filePath,
        reason: record.reason,
      };
    }
    if (record.state === 'invalid') {
      return {
        ok: false,
        status: 'unknown',
        classification: 'invalid',
        cleanupId,
        path: filePath,
        reason: filePath + ' の形式を判定できません: ' + record.reason,
      };
    }
    if (record.state === 'current') {
      return {
        ok: true,
        status: 'skipped',
        cleanupId,
        path: filePath,
        reason: '現行形式のstatus-pane記録は削除しません',
      };
    }
    if (record.state !== 'legacy') {
      return {
        ok: false,
        status: 'unknown',
        cleanupId,
        path: filePath,
        reason: filePath + ' の形式判定結果が不正です: ' + record.state,
      };
    }

    try {
      unlinkFn(filePath);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return { ok: true, status: 'absent', cleanupId, path: filePath };
      }
      return {
        ok: false,
        status: 'unknown',
        cleanupId,
        path: filePath,
        reason: filePath + ' の削除に失敗しました: ' + errorMessage(error),
      };
    }
    return { ok: true, status: 'removed', cleanupId, path: filePath };
  } finally {
    if (locked) {
      try {
        releaseLockFn(workspace);
      } catch {
        // releaseStartupLockは自分のロックだけを解放する後処理であり、
        // 主処理の削除結果を別の副作用へ変えない。
      }
    }
  }
}

const CLEANERS = Object.freeze({
  [STATUS_PANE_CLEANUP_ID]: cleanupStatusPaneRecord,
});

/**
 * 台帳のcleanupIdに対応する、実装済みの整理だけを実行する。
 *
 * @param {object} options
 * @returns {{ok:boolean,status:string,cleanupId:string,reason?:string,path?:string}}
 */
function cleanupLegacyArtifact(options = {}) {
  const cleanupId = options.cleanupId;
  const entry = catalogEntryForCleanupId(cleanupId, options.catalog || CATALOG);
  if (!entry) return unsupported(cleanupId, 'cleanupIdが台帳にありません');

  const cleaner = CLEANERS[cleanupId];
  if (typeof cleaner !== 'function') {
    return unsupported(cleanupId, 'cleanupIdに対応する整理処理が未実装です');
  }
  return cleaner(options);
}

module.exports = {
  STATUS_PANE_CLEANUP_ID,
  catalogEntryForCleanupId,
  cleanupStatusPaneRecord,
  cleanupLegacyArtifact,
};

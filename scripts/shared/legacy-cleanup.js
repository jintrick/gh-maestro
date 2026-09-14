'use strict';

// legacy-cleanup.js — 台帳のcleanupIdから明示的なレガシー整理を実行する。
//
// 検出経路とは別の明示的な入口であり、検出時に自動実行しない。今回扱う
// status-paneの旧形式は接続先を持たないため、記録ファイルだけを削除し、
// paneIdを使ったWezTerm操作は行わない。

const fs = require('fs');
const path = require('path');
const { CATALOG } = require('./legacy-catalog');
const processLifecycle = require('../process-lifecycle');
const {
  classifyStatusPaneRecord,
} = require('./status-pane-legacy');
const { statusPanePath } = require('./status-pane-registry');
const readStateLib = require('./read-state');
const { readWorkersRaw } = require('./workers-registry');

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

  const filePath = statusPanePath(workspace, runtimeRoot);
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

function cleanupLegacyRecords(options = {}) {
  const migrateRecords = require('../migrate-records');
  const scope = options.scope || 'all';
  const out = migrateRecords.runWithInboxSupervisorControl(
    options.workspace,
    scope,
    { dryRun: false },
    () => migrateRecords.planMigration(options.workspace, scope, { dryRun: false }),
  );
  const held = Array.isArray(out.held) ? out.held : [];
  const problems = [out.conflicts, out.unparseable, out.unprocessed, held].flat();
  const hardProblems = [out.conflicts, out.unparseable, out.unprocessed].flat();
  if (hardProblems.length > 0) {
    return {
      status: 'unknown',
      moved: out.moved,
      alreadyMigrated: out.alreadyMigrated,
      held,
      problems,
      reason: problems.map((item) => item.reason || JSON.stringify(item)).join('; '),
    };
  }
  if (held.length > 0) {
    return {
      status: 'skipped',
      moved: out.moved,
      alreadyMigrated: out.alreadyMigrated,
      held,
      problems: held,
      reason: '所有者が稼働中の旧レコードを保持しました',
    };
  }
  if (out.moved.length > 0 || out.alreadyMigrated.length > 0) {
    return { status: 'removed', moved: out.moved, alreadyMigrated: out.alreadyMigrated, held };
  }
  return { status: 'absent' };
}

function cleanupLegacyPidRegistry(options = {}) {
  const sweepRegistryFn = options.sweepRegistryFn || processLifecycle.sweepRegistry;
  // The existing sweep is the authoritative PID-registry cleanup primitive. Do not pass a
  // catch-all match here: sweepRegistry's no-match path is what builds the live-worker and
  // resident exclusions before deciding whether a PID may be stopped. A truthy match would
  // deliberately bypass those exclusions and could stop a current process.
  const result = sweepRegistryFn(options.workspace);
  if (!result || !Array.isArray(result.errors) || !Array.isArray(result.killed)
    || !Array.isArray(result.cleaned)) {
    return { status: 'unknown', reason: 'PID registry sweepが不正な結果を返しました', result };
  }
  if (result.errors.length > 0) return { status: 'unknown', reason: result.errors.join('; '), result };
  return {
    status: result.killed.length > 0 || result.cleaned.length > 0 ? 'removed' : 'absent',
    result,
  };
}

function cleanupLegacyMsgPollState(options = {}) {
  const workspace = options.workspace;
  const directory = path.resolve(workspace, '.gh-maestro', 'msg-state');
  const lstatFn = options.lstatFn || fs.lstatSync;
  const readDirFn = options.readDirFn || ((target) => fs.readdirSync(target, { withFileTypes: true }));
  const readStateFn = options.readStateFn || readStateLib.readState;
  const initializeStateFn = options.initializeStateFn || readStateLib.initializeState;
  let directoryStat;
  try {
    directoryStat = lstatFn(directory);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return { status: 'absent', path: directory };
    return { status: 'unknown', path: directory, reason: error.message };
  }
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    return { status: 'unknown', path: directory, reason: 'msg-stateが通常ディレクトリではありません' };
  }
  let names;
  try {
    names = readDirFn(directory);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return { status: 'absent', path: directory };
    return { status: 'unknown', path: directory, reason: error.message };
  }
  let migrated = 0;
  const skipped = [];
  let workers = options.workers;
  let workersReadError = null;
  if (workers === undefined) {
    try {
      workers = readWorkersRaw(workspace);
    } catch (error) {
      workersReadError = error;
      workers = null;
    }
  }
  for (const dirent of names) {
    if (!dirent.name.endsWith('.json')) continue;
    const filePath = path.join(directory, dirent.name);
    let stat;
    try {
      stat = lstatFn(filePath);
    } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      return { status: 'unknown', path: filePath, reason: error.message };
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { status: 'unknown', path: filePath, reason: 'msg-stateが通常ファイルではありません' };
    }
    const self = dirent.name.slice(0, -'.json'.length);
    const stateResult = readStateFn(workspace, self);
    if (stateResult.status === 'corrupt') {
      return { status: 'unknown', path: filePath, reason: 'msg-stateが破損しています' };
    }
    if (stateResult.status !== 'legacy') continue;
    // orchestrator の v1 state は Issue 全体のスナップショットなしに安全に移行できない。
    // reset-session のベースライン再構築へ委ね、既読集合を捨てない。
    const workerEntry = workers && typeof workers === 'object' && !Array.isArray(workers)
      ? workers[self]
      : null;
    const workerIssue = workerEntry && typeof workerEntry === 'object' && !Array.isArray(workerEntry)
      ? workerEntry.issue
      : null;
    const issue = self === 'orchestrator'
      ? null
      : stateResult.state?.issue ?? options.issueBySelf?.[self] ?? options.issue ?? workerIssue;
    if (issue === undefined || issue === null || String(issue) === '') {
      if (workersReadError) {
        return {
          status: 'unknown',
          path: filePath,
          reason: `workers.jsonの読み取りに失敗したためIssueを特定できません: ${workersReadError.message}`,
        };
      }
      skipped.push(self);
      continue;
    }
    if (stateResult.state?.seenIds !== undefined
      && (!Array.isArray(stateResult.state.seenIds)
        || !stateResult.state.seenIds.every((id) => typeof id === 'number' && Number.isFinite(id)))) {
      return { status: 'unknown', path: filePath, reason: 'legacy msg-stateのseenIdsが不正です' };
    }
    const seenIds = stateResult.state?.seenIds || [];
    const sinceByIssue = {};
    const legacySince = stateResult.state?.since;
    if (legacySince !== undefined && legacySince !== null) {
      if (typeof legacySince === 'string' && legacySince !== '') {
        sinceByIssue[String(issue)] = legacySince;
      } else if (legacySince && typeof legacySince === 'object' && !Array.isArray(legacySince)
        && typeof legacySince[String(issue)] === 'string' && legacySince[String(issue)] !== '') {
        sinceByIssue[String(issue)] = legacySince[String(issue)];
      } else {
        return { status: 'unknown', path: filePath, reason: 'legacy msg-stateのsinceが不正です' };
      }
    }
    const initialized = initializeStateFn(workspace, self, {
      byIssue: { [String(issue)]: seenIds },
      sinceByIssue,
      sessionId: 'legacy-migration',
    });
    if (!initialized.ok) {
      return { status: 'unknown', path: filePath, reason: initialized.error || 'msg-stateの移行に失敗しました' };
    }
    migrated++;
  }
  if (migrated > 0) return { status: 'removed', path: directory, migrated, skipped };
  if (skipped.length > 0) return { status: 'skipped', path: directory, skipped, reason: 'Issueを特定できない旧msg-stateを保持しました' };
  return { status: 'absent', path: directory };
}

const CLEANERS = Object.freeze({
  'gh-maestro-setup.retireAiReviewCi': (options) => require('../gh-maestro-setup')
    .retireAiReviewCi({ ...options, cleanupOnly: true }),
  'gh-maestro-setup.ensureSyncHook': (options) => require('../gh-maestro-setup')
    .cleanupLegacySyncHook(options),
  'gh-maestro-setup.retireChecksHooks': (options) => require('../gh-maestro-setup')
    .cleanupLegacyChecksHook(options),
  'gh-maestro-setup.removeStaleDefaultHooks': (options) => require('../gh-maestro-setup')
    .cleanupLegacyStaleDefaultHooks(options),
  'gh-maestro-setup.ensureGitIgnore': (options) => require('../gh-maestro-setup')
    .ensureGitIgnore({ ...options, cleanupOnly: true }),
  'install.quarantineLegacyAgentsConfig': (options) => require('../install')
    .cleanupLegacyAgentsConfig(options),
  'install.quarantineLegacyHomePids': (options) => require('../install')
    .cleanupLegacyHomePids(options),
  'install.pruneManagedRoot': (options) => require('../install')
    .cleanupLegacyManagedRoot({ ...options, entries: options.parameters?.entries || options.entries || [] }),
  'migrate-records.planMigration': cleanupLegacyRecords,
  'process-lifecycle.sweepRegistry': cleanupLegacyPidRegistry,
  'msg-poll.readState': cleanupLegacyMsgPollState,
  'reset-session.notifierPid': (options) => require('../reset-session')
    .cleanupLegacyWorkerField(options.workspace, 'notifierPid', options),
  'reset-session.paneId': (options) => require('../reset-session')
    .cleanupLegacyWorkerField(options.workspace, 'paneId', options),
  'reset-session.messages': (options) => require('../reset-session')
    .cleanupLegacyMessages(options.workspace, options),
  'reset-session.queue': (options) => require('../reset-session')
    .cleanupLegacyQueue(options.workspace, { ...options, pollerFile: options.parameters?.pollerFile || options.pollerFile }),
  'stop-worker-process.paneId': (options) => require('./stop-worker-process')
    .cleanupLegacyWorkerPanes(options.workspace, options),
  'worker-supervisor-control.legacyName': (options) => require('./worker-supervisor-control')
    .cleanupLegacyWorkerSupervisor({ ...options, script: options.parameters?.script, legacyRole: options.parameters?.legacyRole }),
  'restart-residents.legacyLease': (options) => require('./restart-residents')
    .cleanupLegacyResidentLease(options.workspace, { ...options, role: options.parameters?.role }),
  'spawn-worker.rolelessGuard': (options) => require('../spawn-worker')
    .cleanupRolelessWorkers(options.workspace, { ...options, namePattern: options.parameters?.namePattern }),
  [STATUS_PANE_CLEANUP_ID]: cleanupStatusPaneRecord,
});

const CLEANUP_STATUSES = Object.freeze(['removed', 'absent', 'skipped', 'unknown', 'unsupported']);

function cleanupWiringErrors(catalog, cleaners) {
  const catalogIds = new Set(catalog.map((entry) => entry.cleanupId).filter(Boolean));
  const errors = [];
  for (const entry of catalog) {
    if (entry.integrationStatus === 'integrated' && typeof cleaners[entry.cleanupId] !== 'function') {
      errors.push(`integrated catalog item has no cleaner: ${entry.cleanupId}`);
    }
  }
  for (const cleanupId of Object.keys(cleaners)) {
    if (!catalogIds.has(cleanupId)) errors.push(`cleaner has no catalog item: ${cleanupId}`);
  }
  return errors;
}

const cleanupErrors = cleanupWiringErrors(CATALOG, CLEANERS);
if (cleanupErrors.length > 0) {
  throw new Error(`legacy cleanup wiring is invalid:\n${cleanupErrors.join('\n')}`);
}

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
  let result;
  try {
    result = cleaner({ ...options, catalogEntry: entry, parameters: entry.parameters || {} });
  } catch (error) {
    return {
      ok: false,
      status: 'unknown',
      cleanupId,
      reason: errorMessage(error),
    };
  }
  const status = result && CLEANUP_STATUSES.includes(result.status) ? result.status : 'unknown';
  return {
    ...(result && typeof result === 'object' ? result : {}),
    ok: status === 'removed' || status === 'absent' || status === 'skipped',
    status,
    cleanupId,
    ...(status === 'unknown' && !result?.reason ? { reason: 'cleanup処理が不正な結果を返しました' } : {}),
  };
}

module.exports = {
  STATUS_PANE_CLEANUP_ID,
  CLEANUP_STATUSES,
  CLEANERS,
  cleanupWiringErrors,
  catalogEntryForCleanupId,
  cleanupStatusPaneRecord,
  cleanupLegacyArtifact,
};

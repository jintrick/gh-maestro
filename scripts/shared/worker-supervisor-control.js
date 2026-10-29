'use strict';
// worker-supervisor-control.js — 稼働中の worker-supervisor の検知・停止。
//
// migrate-records.js が `--scope worker-supervisor`（または all）で記録を移行する際、
// 既に稼働中の worker-supervisor が移行対象の記録を書き続けないよう、ツール自身が
// プロセスを検知して停止するために使う（Issue #256）。停止後はマーカー
// （migration-marker.js）で自動起動を抑制し、移行完了後に削除する。worker-supervisor の
// 再開は既存の自動起動機構（ensure-worker-supervisor.js）が次の必要時に引き受ける。
//
// 検知は2つの既存機構を併用する:
//   - PID registry: process-lifecycle.js::findRunningInstance
//     （worker-supervisor.js が起動時に registerProcess で自己登録する）
//   - role lease（排他の正本、Issue #240）: worker-lease.js
//     （acquireResidentLease で取得。プロセスが死ねば isLeaseLive が false になるため、
//       stale lease を誤って kill 対象にすることはない）
//
// 停止は kill-tree.js::killProcessTree（Windows: taskkill /F /T、Unix: SIGTERM グループ）。
// 強制終了で SIGTERM ハンドラのクリーンアップは走らないが、残った role lease / registry
// エントリは次回起動時に stale として回収されるため（findRunningInstance /
// acquireResidentLease の既存ロジック）、安全に再起動できる。
//
// 検知失敗時は fail-open（空として扱い停止しない）。マーカーによる自動起動抑制が
// 「新配置への空状態書き込み」を防ぐ主防衛線であり、停止漏れの最悪系は旧配置への
// 書き残し止まり（移行側の衝突検出も後背にある）。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const fs = require('fs');
const path = require('path');
const { killProcessTree } = require('./kill-tree');
const {
  WORKER_SUPERVISOR_ROLE,
  LEGACY_INBOX_SUPERVISOR_ROLE,
  roleLeaseKey,
  isLeaseLive,
  createResidentLeaseStore,
  acquireLeaseLock,
  releaseLeaseLock,
} = require('./worker-lease');

// migrate-records.js keeps the old scope as a source-layout compatibility
// alias, while the public name is canonical.  Keep this mapping here so the
// CLI validation and process-control decision cannot drift apart.
const WORKER_SUPERVISOR_MIGRATION_SCOPE = 'worker-supervisor';
const LEGACY_INBOX_SUPERVISOR_MIGRATION_SCOPE = 'inbox-supervisor';
const SUPERVISOR_MIGRATION_SCOPES = Object.freeze([
  WORKER_SUPERVISOR_MIGRATION_SCOPE,
  LEGACY_INBOX_SUPERVISOR_MIGRATION_SCOPE,
]);

function isWorkerSupervisorMigrationScope(scope) {
  return SUPERVISOR_MIGRATION_SCOPES.includes(scope);
}

// process-lifecycle への依存は呼び出し時点で解決する（Issue #267）。CLI 主経路
// （require.main === module）から sweepRegistry 経由でこのモジュールが require される
// 可能性を踏まえ、評価時に捕捉すると module.exports 未確定の undefined を掴むため、
// 最初の呼び出し時まで解決を遅らせる。テスト注入（_set*）は注入値が優先される。
let _injectedFindRunningInstance = null;

function _findRunningInstance(workspace, opts) {
  const fn = _injectedFindRunningInstance ?? require('../process-lifecycle').findRunningInstance;
  return fn(workspace, opts);
}

let _createResidentLeaseStore = createResidentLeaseStore;
let _isLeaseLive = isLeaseLive;
let _killProcessTree = killProcessTree;

function isValidPid(pid) {
  return typeof pid === 'number' && Number.isFinite(pid) && pid > 0;
}

/**
 * 稼働中の worker-supervisor の PID を検知する（registry と role lease の両方を参照、
 * 重複排除済み）。検知不能・検知失敗時は空配列を返す（fail-open）。
 *
 * @param {string} workspace
 * @returns {number[]}
 */
function runningPidsForScriptsAndRoles(workspace, scriptNames, roles) {
  const pids = new Set();

  // PID registry。旧script名も移行期間だけ union して読む。
  for (const script of scriptNames) {
    try {
      const entry = _findRunningInstance(workspace, { script, workerName: null });
      if (entry && isValidPid(entry.pid)) pids.add(entry.pid);
    } catch {
      // registry 読取失敗時は role lease 側で拾えれば拾う
    }
  }

  // role lease（排他の正本）。isLeaseLive が startTime 照合まで行うため、PID 再利用や
  // 改ざんされた lease を停止対象にすることはない。
  try {
    const store = _createResidentLeaseStore(workspace);
    for (const role of roles) {
      const entry = store.read(roleLeaseKey(role));
      if (_isLeaseLive(entry) && isValidPid(entry.pid)) pids.add(entry.pid);
    }
  } catch {
    // role lease 読取失敗時も停止対象なしとして続行
  }

  return [...pids];
}

function runningLegacyWorkerSupervisorPids(workspace) {
  return runningPidsForScriptsAndRoles(
    workspace,
    ['inbox-supervisor.js'],
    [LEGACY_INBOX_SUPERVISOR_ROLE],
  );
}

function runningWorkerSupervisorPids(workspace) {
  return runningPidsForScriptsAndRoles(
    workspace,
    ['worker-supervisor.js', 'inbox-supervisor.js'],
    [WORKER_SUPERVISOR_ROLE, LEGACY_INBOX_SUPERVISOR_ROLE],
  );
}

/**
 * 稼働中の worker-supervisor を全て停止する。best-effort（個別の kill 失敗は無視）。
 *
 * @param {string} workspace
 * @returns {number[]} 停止処理を行った PID の一覧
 */
function stopRunningWorkerSupervisors(workspace) {
  const stopped = [];
  for (const pid of runningWorkerSupervisorPids(workspace)) {
    try {
      _killProcessTree(pid);
      stopped.push(pid);
    } catch {
      // 停止失敗は無視（残ったプロセスは移行側の held / 衝突検出が防ぐ）
    }
  }
  return stopped;
}

function cleanupLegacyWorkerSupervisor(options = {}) {
  const workspace = options.workspace;
  if (typeof workspace !== 'string' || workspace === '') throw new Error('workspaceが必要です');
  const lifecycle = require('../process-lifecycle');
  const legacyDir = options.legacyPidDir || lifecycle.legacyPidsDir(workspace);
  const runtimeDir = options.runtimePidDir || lifecycle.pidsDir(workspace);
  const dirs = [legacyDir, runtimeDir];
  const readDirFn = options.readDirFn || ((dir) => fs.readdirSync(dir));
  const lstatFn = options.lstatFn || fs.lstatSync;
  const readFileFn = options.readFileFn || ((filePath) => fs.readFileSync(filePath, 'utf8'));
  const unlinkFn = options.unlinkFn || fs.unlinkSync;
  const isProcessAliveFn = options.isProcessAliveFn || lifecycle.isProcessAlive;
  const verifyProcessIdentityFn = options.verifyProcessIdentityFn || lifecycle.verifyProcessIdentity;
  const killProcessTreeFn = options.killProcessTreeFn || _killProcessTree;
  const script = options.script || 'inbox-supervisor.js';
  const role = options.legacyRole || LEGACY_INBOX_SUPERVISOR_ROLE;
  const entries = [];
  const errors = [];

  for (const dir of dirs) {
    let names;
    try {
      names = readDirFn(dir);
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) continue;
      errors.push(`${dir} の列挙に失敗しました: ${error.message}`);
      continue;
    }
    for (const name of names) {
      const fileName = typeof name === 'string' ? name : name.name;
      if (typeof fileName !== 'string' || !fileName.endsWith('.json')) continue;
      const filePath = path.join(dir, fileName);
      let stat;
      try {
        stat = lstatFn(filePath);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('通常ファイルではありません');
      } catch (error) {
        errors.push(`${filePath} の確認に失敗しました: ${error.message}`);
        continue;
      }
      let entry;
      try {
        entry = JSON.parse(readFileFn(filePath, 'utf8'));
      } catch (error) {
        errors.push(`${filePath} のJSON読み取りに失敗しました: ${error.message}`);
        continue;
      }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push(`${filePath} のregistryエントリがオブジェクトではありません`);
        continue;
      }
      if (entry.script !== script) continue;
      if (!isValidPid(entry.pid) || !Number.isInteger(entry.pid)
        || typeof entry.startTime !== 'string' || entry.startTime === '') {
        errors.push(`${filePath} のPID/startTimeが不正です`);
        continue;
      }
      entries.push({ filePath, entry });
    }
  }

  let removedCount = 0;
  let skipped = false;
  const removeFile = (filePath) => {
    try { unlinkFn(filePath); return true; } catch (error) {
      if (error && error.code === 'ENOENT') return true;
      errors.push(`${filePath} の削除に失敗しました: ${error.message}`);
      return false;
    }
  };
  const byPid = new Map();
  for (const item of entries) {
    if (!byPid.has(item.entry.pid)) byPid.set(item.entry.pid, []);
    byPid.get(item.entry.pid).push(item.filePath);
  }
  for (const [pid, filePaths] of byPid) {
    let alive;
    try { alive = isProcessAliveFn(pid); } catch (error) {
      errors.push(`PID ${pid} の生存確認に失敗しました: ${error.message}`);
      continue;
    }
    if (typeof alive !== 'boolean') {
      errors.push(`PID ${pid} の生存確認がbooleanを返しませんでした`);
      continue;
    }
    const metadata = entries.find((item) => item.entry.pid === pid).entry;
    if (alive) {
      let identity;
      try { identity = verifyProcessIdentityFn(pid, metadata); } catch (error) {
        errors.push(`PID ${pid} の同一性確認に失敗しました: ${error.message}`);
        continue;
      }
      if (!identity || identity.match !== true) {
        errors.push(`PID ${pid} は旧inbox-supervisorと同一だと確認できません: ${identity?.reason || 'identity mismatch'}`);
        continue;
      }
      try {
        killProcessTreeFn(pid);
        const remaining = isProcessAliveFn(pid);
        if (remaining !== false) throw new Error('停止を確認できませんでした');
      } catch (error) {
        errors.push(`旧inbox-supervisor (pid ${pid}) の停止に失敗しました: ${error.message}`);
        continue;
      }
    }
    for (const filePath of filePaths) if (removeFile(filePath)) removedCount++;
  }

  const leasePath = path.join(workspace, '.gh-maestro', 'leases', `${roleLeaseKey(role)}.json`);
  let leaseExists = false;
  try {
    const stat = lstatFn(leasePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('leaseが通常ファイルではありません');
    leaseExists = true;
  } catch (error) {
    if (!(error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))) {
      errors.push(`${leasePath} の確認に失敗しました: ${error.message}`);
    }
  }
  if (leaseExists) {
    let lease;
    try { lease = JSON.parse(readFileFn(leasePath, 'utf8')); } catch (error) {
      errors.push(`${leasePath} のJSON読み取りに失敗しました: ${error.message}`);
      lease = null;
    }
    if (!lease || typeof lease !== 'object' || Array.isArray(lease)
      || !isValidPid(lease.pid) || !Number.isInteger(lease.pid)
      || typeof lease.startTime !== 'string' || lease.startTime === '') {
      errors.push(`${leasePath} のlease形式が不正です`);
    } else {
      let alive;
      try { alive = isProcessAliveFn(lease.pid); } catch (error) {
        errors.push(`lease PID ${lease.pid} の生存確認に失敗しました: ${error.message}`);
        alive = null;
      }
      if (typeof alive !== 'boolean') {
        if (alive !== null) errors.push(`lease PID ${lease.pid} の生存確認がbooleanを返しませんでした`);
      }
      let removable = alive === false;
      if (alive === true) {
        let identity;
        let identityError = false;
        try { identity = verifyProcessIdentityFn(lease.pid, lease); } catch (error) {
          errors.push(`lease PID ${lease.pid} の同一性確認に失敗しました: ${error.message}`);
          identityError = true;
          identity = null;
        }
        if (identity && identity.match === true) {
          skipped = true;
        } else if (!identityError) {
          errors.push(`lease PID ${lease.pid} の同一性を確認できません: ${identity?.reason || 'identity mismatch'}`);
        }
      }
      if (removable) {
        let store;
        let locked = false;
        try {
          store = (options.createResidentLeaseStoreFn || _createResidentLeaseStore)(workspace);
          locked = (options.acquireLeaseLockFn || acquireLeaseLock)(store, roleLeaseKey(role));
          if (!locked) throw new Error('lease lockを取得できませんでした');
          const current = JSON.parse(readFileFn(leasePath, 'utf8'));
          if (current.pid !== lease.pid || current.startTime !== lease.startTime) {
            throw new Error('leaseが確認後に変更されました');
          }
          if (!removeFile(leasePath)) throw new Error('leaseの削除に失敗しました');
          removedCount++;
        } catch (error) {
          errors.push(`${leasePath} の削除に失敗しました: ${error.message}`);
        } finally {
          if (locked) {
            try { (options.releaseLeaseLockFn || releaseLeaseLock)(store, roleLeaseKey(role)); } catch (error) {
              errors.push(`${leasePath} のロック解放に失敗しました: ${error.message}`);
            }
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    return { status: 'unknown', reason: errors.join('; '), removed: removedCount };
  }
  if (skipped) return { status: 'skipped', reason: '旧inbox-supervisorのlease所有者が稼働中です' };
  return { status: removedCount > 0 ? 'removed' : 'absent' };
}

module.exports = {
  WORKER_SUPERVISOR_MIGRATION_SCOPE,
  LEGACY_INBOX_SUPERVISOR_MIGRATION_SCOPE,
  SUPERVISOR_MIGRATION_SCOPES,
  isWorkerSupervisorMigrationScope,
  runningWorkerSupervisorPids,
  runningLegacyWorkerSupervisorPids,
  stopRunningWorkerSupervisors,
  cleanupLegacyWorkerSupervisor,
  // migrate-records.js の既存API名。移行処理を二重化せず既存契約を保つための別名。
  runningInboxSupervisorPids: runningWorkerSupervisorPids,
  stopRunningInboxSupervisors: stopRunningWorkerSupervisors,
  // テスト用注入（実プロセスは起動・killしない）
  _setFindRunningInstance: (fn) => { _injectedFindRunningInstance = fn; },
  _setCreateResidentLeaseStore: (fn) => { _createResidentLeaseStore = fn; },
  _setIsLeaseLive: (fn) => { _isLeaseLive = fn; },
  _setKillProcessTree: (fn) => { _killProcessTree = fn; },
};

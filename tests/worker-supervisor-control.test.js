'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const control = require('../scripts/shared/worker-supervisor-control');
const { findRunningInstance } = require('../scripts/process-lifecycle');
const { killProcessTree } = require('../scripts/shared/kill-tree');
const workerLease = require('../scripts/shared/worker-lease');

let workspace;

// _set... 注入はモジュール内のモジュール変数を書き換えるため、テスト間で
// 実装を跨いで持ち越さないよう、beforeEach/afterEach で必ず実装へ戻す
// （実プロセスは起動・killしない）。
function resetInjectables() {
  control._setFindRunningInstance(findRunningInstance);
  control._setCreateResidentLeaseStore(workerLease.createResidentLeaseStore);
  control._setIsLeaseLive(workerLease.isLeaseLive);
  control._setKillProcessTree(killProcessTree);
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-supervisor-control-'));
  resetInjectables();
});

afterEach(() => {
  resetInjectables();
});

test('runningWorkerSupervisorPids: registry エントリからPIDを検知する', () => {
  control._setFindRunningInstance(() => ({ pid: 111, script: 'worker-supervisor.js' }));
  control._setCreateResidentLeaseStore(() => ({ read: () => null }));
  control._setIsLeaseLive(() => false);

  assert.deepEqual(control.runningWorkerSupervisorPids(workspace), [111]);
});

test('runningLegacyWorkerSupervisorPids: 改名前のregistryエントリを検知する', () => {
  control._setFindRunningInstance((_, opts) => (
    opts.script === 'inbox-supervisor.js' ? { pid: 112, script: opts.script } : null
  ));
  control._setCreateResidentLeaseStore(() => ({ read: () => null }));
  control._setIsLeaseLive(() => false);

  assert.deepEqual(control.runningLegacyWorkerSupervisorPids(workspace), [112]);
});

test('runningWorkerSupervisorPids: role lease（排他の正本）からPIDを検知する', () => {
  control._setFindRunningInstance(() => null);
  control._setCreateResidentLeaseStore(() => ({ read: () => ({ pid: 222, startTime: '2026-08-01T00:00:00.000Z' }) }));
  control._setIsLeaseLive(() => true);

  assert.deepEqual(control.runningWorkerSupervisorPids(workspace), [222]);
});

test('runningWorkerSupervisorPids: registry と lease の同一PIDは重複排除する', () => {
  control._setFindRunningInstance(() => ({ pid: 333, script: 'worker-supervisor.js' }));
  control._setCreateResidentLeaseStore(() => ({ read: () => ({ pid: 333, startTime: '2026-08-01T00:00:00.000Z' }) }));
  control._setIsLeaseLive(() => true);

  assert.deepEqual(control.runningWorkerSupervisorPids(workspace), [333]);
});

test('runningWorkerSupervisorPids: 稼働中なしは空配列を返す', () => {
  control._setFindRunningInstance(() => null);
  control._setCreateResidentLeaseStore(() => ({ read: () => null }));
  control._setIsLeaseLive(() => false);

  assert.deepEqual(control.runningWorkerSupervisorPids(workspace), []);
});

test('runningWorkerSupervisorPids: 不正なPID（非正数）は停止対象から除外する', () => {
  control._setFindRunningInstance(() => ({ pid: 0, script: 'worker-supervisor.js' }));
  control._setCreateResidentLeaseStore(() => ({ read: () => ({ pid: -5, startTime: '2026-08-01T00:00:00.000Z' }) }));
  control._setIsLeaseLive(() => true);

  assert.deepEqual(control.runningWorkerSupervisorPids(workspace), []);
});

test('runningWorkerSupervisorPids: 検知失敗（例外）は fail-open で空配列', () => {
  control._setFindRunningInstance(() => { throw new Error('registry boom'); });
  control._setCreateResidentLeaseStore(() => { throw new Error('lease boom'); });

  assert.deepEqual(control.runningWorkerSupervisorPids(workspace), []);
});

test('stopRunningWorkerSupervisors: 検知したPIDをkillProcessTreeで停止する', () => {
  control._setFindRunningInstance(() => ({ pid: 444, script: 'worker-supervisor.js' }));
  control._setCreateResidentLeaseStore(() => ({ read: () => null }));
  control._setIsLeaseLive(() => false);
  const killed = [];
  control._setKillProcessTree((pid) => { killed.push(pid); });

  const stopped = control.stopRunningWorkerSupervisors(workspace);
  assert.deepEqual(stopped, [444]);
  assert.deepEqual(killed, [444]);
});

test('stopRunningWorkerSupervisors: 個別のkill失敗は無視する（best-effort）', () => {
  control._setFindRunningInstance(() => ({ pid: 555, script: 'worker-supervisor.js' }));
  control._setCreateResidentLeaseStore(() => ({ read: () => null }));
  control._setIsLeaseLive(() => false);
  control._setKillProcessTree(() => { throw new Error('taskkill failed'); });

  assert.deepEqual(control.stopRunningWorkerSupervisors(workspace), []);
});

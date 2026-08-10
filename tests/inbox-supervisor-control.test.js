'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const control = require('../scripts/shared/inbox-supervisor-control');
const { findRunningInstance } = require('../scripts/process-lifecycle');
const { killProcessTree } = require('../scripts/kill-tree');
const workerLease = require('../scripts/shared/worker-lease');

let workspace;

// _set... 注入はモジュール内のモジュール変数を書き換えるため、テスト間で
// 実装を跨いで持ち越さないよう、beforeEach/afterEach で必ず実装へ戻す
// （.claude/rules/test-process-spawn-safety.md 準拠。実プロセスは起動・killしない）。
function resetInjectables() {
  control._setFindRunningInstance(findRunningInstance);
  control._setCreateResidentLeaseStore(workerLease.createResidentLeaseStore);
  control._setIsLeaseLive(workerLease.isLeaseLive);
  control._setKillProcessTree(killProcessTree);
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-supervisor-control-'));
  resetInjectables();
});

afterEach(() => {
  resetInjectables();
});

test('runningInboxSupervisorPids: registry エントリからPIDを検知する', () => {
  control._setFindRunningInstance(() => ({ pid: 111, script: 'inbox-supervisor.js' }));
  control._setCreateResidentLeaseStore(() => ({ read: () => null }));
  control._setIsLeaseLive(() => false);

  assert.deepEqual(control.runningInboxSupervisorPids(workspace), [111]);
});

test('runningInboxSupervisorPids: role lease（排他の正本）からPIDを検知する', () => {
  control._setFindRunningInstance(() => null);
  control._setCreateResidentLeaseStore(() => ({ read: () => ({ pid: 222, startTime: '2026-08-01T00:00:00.000Z' }) }));
  control._setIsLeaseLive(() => true);

  assert.deepEqual(control.runningInboxSupervisorPids(workspace), [222]);
});

test('runningInboxSupervisorPids: registry と lease の同一PIDは重複排除する', () => {
  control._setFindRunningInstance(() => ({ pid: 333, script: 'inbox-supervisor.js' }));
  control._setCreateResidentLeaseStore(() => ({ read: () => ({ pid: 333, startTime: '2026-08-01T00:00:00.000Z' }) }));
  control._setIsLeaseLive(() => true);

  assert.deepEqual(control.runningInboxSupervisorPids(workspace), [333]);
});

test('runningInboxSupervisorPids: 稼働中なしは空配列を返す', () => {
  control._setFindRunningInstance(() => null);
  control._setCreateResidentLeaseStore(() => ({ read: () => null }));
  control._setIsLeaseLive(() => false);

  assert.deepEqual(control.runningInboxSupervisorPids(workspace), []);
});

test('runningInboxSupervisorPids: 不正なPID（非正数）は停止対象から除外する', () => {
  control._setFindRunningInstance(() => ({ pid: 0, script: 'inbox-supervisor.js' }));
  control._setCreateResidentLeaseStore(() => ({ read: () => ({ pid: -5, startTime: '2026-08-01T00:00:00.000Z' }) }));
  control._setIsLeaseLive(() => true);

  assert.deepEqual(control.runningInboxSupervisorPids(workspace), []);
});

test('runningInboxSupervisorPids: 検知失敗（例外）は fail-open で空配列', () => {
  control._setFindRunningInstance(() => { throw new Error('registry boom'); });
  control._setCreateResidentLeaseStore(() => { throw new Error('lease boom'); });

  assert.deepEqual(control.runningInboxSupervisorPids(workspace), []);
});

test('stopRunningInboxSupervisors: 検知したPIDをkillProcessTreeで停止する', () => {
  control._setFindRunningInstance(() => ({ pid: 444, script: 'inbox-supervisor.js' }));
  control._setCreateResidentLeaseStore(() => ({ read: () => null }));
  control._setIsLeaseLive(() => false);
  const killed = [];
  control._setKillProcessTree((pid) => { killed.push(pid); });

  const stopped = control.stopRunningInboxSupervisors(workspace);
  assert.deepEqual(stopped, [444]);
  assert.deepEqual(killed, [444]);
});

test('stopRunningInboxSupervisors: 個別のkill失敗は無視する（best-effort）', () => {
  control._setFindRunningInstance(() => ({ pid: 555, script: 'inbox-supervisor.js' }));
  control._setCreateResidentLeaseStore(() => ({ read: () => null }));
  control._setIsLeaseLive(() => false);
  control._setKillProcessTree(() => { throw new Error('taskkill failed'); });

  assert.deepEqual(control.stopRunningInboxSupervisors(workspace), []);
});

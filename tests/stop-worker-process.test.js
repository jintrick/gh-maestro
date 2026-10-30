'use strict';

const { installLivenessTestAdapter } = require('./helpers/process-liveness-test-double');
installLivenessTestAdapter();

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const storageLayout = require('../scripts/shared/storage-layout');
const cycleMetrics = require('../scripts/shared/cycle-metrics');

const { stopWorkerProcess, cleanupLegacyWorkerPanes } = require('../scripts/shared/stop-worker-process');
const stopWorkerCli = require('../scripts/stop-worker');
const { createTempDirScope } = require('../scripts/shared/temp-directory');
const tempDirScope = createTempDirScope();
test.after(() => tempDirScope.cleanup());

function withWorkspace(callback) {
  const workspace = tempDirScope.mkdtemp('ghm-stop-cleanup-');
  try {
    fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
    return callback(workspace);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

test('stopWorkerProcess: 生死unknownではremove modeでも停止に進まない', () => {
  withWorkspace((workspace) => {
    let killed = false;
    const liveness = require('../scripts/shared/process-liveness').createLiveness({
      probeEndpoint: () => 'unknown',
    });
    assert.throws(() => stopWorkerProcess(workspace, 'worker', {
      isRemoveMode: true,
      _injectedWorkers: { worker: { pid: 101, resourceKey: 'unknown-resource', agentId: 'agent' } },
      liveness,
      killProcessTreeFn: () => { killed = true; },
    }), /生死を判定できません/);
    assert.equal(killed, false);
  });
});

test('stopWorkerProcess: 不正なPIDは欠落扱いせず停止を拒否する', () => {
  withWorkspace((workspace) => {
    let killed = false;
    assert.throws(() => stopWorkerProcess(workspace, 'worker', {
      isRemoveMode: true,
      _injectedWorkers: { worker: { pid: 'not-a-pid' } },
      killProcessTreeFn: () => { killed = true; },
    }), /PID記録が不正/);
    assert.equal(killed, false);
  });
});

test('stopWorkerProcess: PID registry sweep error is returned as unsuccessful', () => {
  withWorkspace((workspace) => {
    const runtimeRoot = path.join(workspace, '.test-runtime');
    const pidsDir = path.join(storageLayout.workspaceRuntimeDir(workspace, runtimeRoot), 'pids');
    fs.mkdirSync(pidsDir, { recursive: true });
    fs.writeFileSync(path.join(pidsDir, 'corrupt.json'), '{broken registry', 'utf8');

    const previousRuntimeRoot = process.env.GH_MAESTRO_RUNTIME_DIR;
    process.env.GH_MAESTRO_RUNTIME_DIR = runtimeRoot;
    try {
      const warnings = [];
      const result = stopWorkerProcess(workspace, 'worker', {
        _injectedWorkers: { worker: {} },
        logWarn: (message) => warnings.push(message),
      });

      assert.equal(result.success, false);
      assert.equal(result.errors.length, 1);
      assert.match(result.errors[0], /corrupt\.json/);
      assert.ok(warnings.some((message) => message.includes('PID registry error')));
    } finally {
      if (previousRuntimeRoot === undefined) delete process.env.GH_MAESTRO_RUNTIME_DIR;
      else process.env.GH_MAESTRO_RUNTIME_DIR = previousRuntimeRoot;
    }
  });
});

test('stop-worker: success=false は停止未確認として非0 statusを返す', () => {
  withWorkspace((workspace) => {
    const errors = [];
    const status = stopWorkerCli.main(['worker', '--workspace', workspace], {
      stopWorkerProcessFn: () => ({ success: false, errors: ['registry unreadable'] }),
      errorFn: (message) => errors.push(message),
    });

    assert.equal(status, 1);
    assert.deepEqual(errors, [
      'stop-worker: 停止処理を完了できませんでした（PID registry の処理に未解決エラーがあります）',
    ]);
  });
});

test('stopWorkerProcess: 生存PIDを停止しworker-stopped cycle eventを記録する', () => {
  withWorkspace((workspace) => {
    const workerName = 'issue-662-test-worker';
    const startTime = '2026-10-30T00:00:00.000Z';
    const killed = [];
    const result = stopWorkerProcess(workspace, workerName, {
      _injectedWorkers: {
        [workerName]: { pid: process.pid, startTime, agentId: 'codex', skill: 'gh-maestro-coder' },
      },
      killProcessTreeFn: (pid) => { killed.push(pid); return { success: true }; },
      sleepFn: () => {},
    });

    assert.equal(result.success, true);
    assert.equal(result.stoppedPid, process.pid);
    assert.deepEqual(killed, [process.pid]);

    const events = cycleMetrics.readCycleEvents(workspace, 662);
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'worker-stopped');
    assert.equal(events[0].workerName, workerName);
    assert.equal(events[0].agentId, 'codex');
    assert.equal(events[0].pid, process.pid);
    assert.equal(events[0].startTime, startTime);
    assert.equal(events[0].abnormal, true);
  });
});

test('cleanupLegacyWorkerPanes: live paneだけをkillしてworkers.jsonのpaneIdを消す', () => {
  withWorkspace((workspace) => {
    const workersPath = path.join(workspace, '.gh-maestro', 'workers.json');
    fs.writeFileSync(workersPath, JSON.stringify({
      orchestrator: { paneId: '1' },
      'issue-1-old': { paneId: ' 7 ', pid: 101 },
      'issue-2-old': { paneId: '8', pid: 102 },
    }), 'utf8');
    const killed = [];
    const result = cleanupLegacyWorkerPanes(workspace, {
      alivePanes: new Set(['7']),
      killPaneFn: (paneId) => { killed.push(paneId); return { ok: true }; },
      sleepFn: () => {},
    });
    assert.equal(result.status, 'removed');
    assert.deepEqual(killed, ['7']);
    const workers = JSON.parse(fs.readFileSync(workersPath, 'utf8'));
    assert.equal(workers.orchestrator.paneId, '1');
    assert.equal(workers['issue-1-old'].paneId, null);
    assert.equal(workers['issue-2-old'].paneId, null);
  });
});

test('cleanupLegacyWorkerPanes: pane照会失敗時はworkers.jsonを変更しない', () => {
  withWorkspace((workspace) => {
    const workersPath = path.join(workspace, '.gh-maestro', 'workers.json');
    const original = { 'issue-1-old': { paneId: '7' } };
    fs.writeFileSync(workersPath, JSON.stringify(original), 'utf8');
    assert.throws(
      () => cleanupLegacyWorkerPanes(workspace, { getAlivePaneIdsFn: () => null }),
      /生存一覧/,
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(workersPath, 'utf8')), original);
  });
});

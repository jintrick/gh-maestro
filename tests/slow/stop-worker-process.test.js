'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const processLiveness = require('../../scripts/shared/process-liveness');
const { killProcessTree } = require('../../scripts/shared/kill-tree');
const { stopWorkerProcess } = require('../../scripts/shared/stop-worker-process');
const cycleMetrics = require('../../scripts/shared/cycle-metrics');
const { cleanSpawnEnv } = require('../_spawn-env');

const LIVENESS_MODULE = require.resolve('../../scripts/shared/process-liveness');

async function withTempWorkspace(callback) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-stop-worker-slow-'));
  fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
  try {
    return await callback(workspace);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function waitForFile(filePath, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  if (!fs.existsSync(filePath)) throw new Error('子プロセスの起動確認が期限内に完了しませんでした');
}

function waitForChildClose(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener('close', onClose);
      child.removeListener('error', onError);
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`子プロセスが ${timeoutMs}ms 以内に終了しませんでした`));
    }, timeoutMs);
    child.once('close', onClose);
    child.once('error', onError);
  });
}

test('stopWorkerProcess: 実プロセスを停止してworker-stopped cycle eventを記録する', async () => {
  await withTempWorkspace(async (workspace) => {
    const workerName = 'issue-662-stop-worker-process-test';
    const runtimeRoot = path.join(workspace, '.test-runtime');
    const readyFile = path.join(workspace, 'worker-ready.json');
    const startTime = new Date().toISOString();
    const previousRuntimeRoot = process.env.GH_MAESTRO_RUNTIME_DIR;
    process.env.GH_MAESTRO_RUNTIME_DIR = runtimeRoot;

    const childSource = [
      "const fs = require('node:fs');",
      `const liveness = require(${JSON.stringify(LIVENESS_MODULE)});`,
      "const ref = liveness.captureSelf({ workspace: process.env.GH_MAESTRO_WORKSPACE, kind: 'worker', name: process.env.GHM_TEST_WORKER_NAME });",
      "fs.writeFileSync(process.argv[1], JSON.stringify(liveness.writeRef({}, ref)), 'utf8');",
      'setInterval(() => {}, 1000);',
    ].join('\n');

    let child;
    try {
      child = spawn(process.execPath, ['-e', childSource, readyFile], {
        cwd: workspace,
        detached: true,
        env: {
          ...cleanSpawnEnv(),
          GH_MAESTRO_WORKSPACE: workspace,
          GH_MAESTRO_RUNTIME_DIR: runtimeRoot,
          GHM_TEST_WORKER_NAME: workerName,
        },
        stdio: 'ignore',
        windowsHide: true,
      });
      waitForFile(readyFile);

      const workerIdentity = JSON.parse(fs.readFileSync(readyFile, 'utf8'));
      assert.equal(processLiveness.observe(processLiveness.readRef(workerIdentity)), 'alive');

      const result = stopWorkerProcess(workspace, workerName, {
        _injectedWorkers: {
          [workerName]: {
            ...workerIdentity,
            startTime,
            agentId: 'codex',
            skill: 'gh-maestro-coder',
          },
        },
      });

      assert.equal(result.success, true);
      assert.equal(result.stoppedPid, child.pid);
      await waitForChildClose(child);
      assert.equal(processLiveness.observe(processLiveness.readRef(workerIdentity)), 'dead');

      const events = cycleMetrics.readCycleEvents(workspace, 662);
      assert.equal(events.length, 1);
      assert.equal(events[0].event, 'worker-stopped');
      assert.equal(events[0].workerName, workerName);
      assert.equal(events[0].agentId, 'codex');
      assert.equal(events[0].pid, child.pid);
      assert.equal(events[0].startTime, startTime);
      assert.equal(events[0].abnormal, true);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null && child.pid) {
        try { killProcessTree(child.pid, { timeoutMs: 5000 }); } catch {}
        try { await waitForChildClose(child, 2000); } catch {}
      }
      if (previousRuntimeRoot === undefined) delete process.env.GH_MAESTRO_RUNTIME_DIR;
      else process.env.GH_MAESTRO_RUNTIME_DIR = previousRuntimeRoot;
    }
  });
});

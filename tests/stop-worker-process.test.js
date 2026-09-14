'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { cleanupLegacyWorkerPanes } = require('../scripts/shared/stop-worker-process');
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

test('cleanupLegacyWorkerPanes: live paneだけをkillしてworkers.jsonのpaneIdを消す', () => {
  withWorkspace((workspace) => {
    const workersPath = path.join(workspace, '.gh-maestro', 'workers.json');
    fs.writeFileSync(workersPath, JSON.stringify({
      orchestrator: { paneId: '1' },
      'issue-1-old': { paneId: '7', pid: 101 },
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

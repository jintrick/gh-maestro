'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ARTIFACTS,
  recordPath,
} = require('../scripts/shared/record-paths');
const metrics = require('../scripts/shared/cycle-metrics');

function tempWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-cycle-metrics-'));
  fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
  return workspace;
}

function cleanup(workspace) {
  fs.rmSync(workspace, { recursive: true, force: true });
}

test('recordCycleEvent: Issue record配下へイベント引数を保持して追記する', () => {
  const workspace = tempWorkspace();
  try {
    const result = metrics.recordCycleEvent(workspace, 450, 'worker-stopped', {
      workerName: 'issue-450-senior-coder-cycle-metrics',
      role: 'senior-coder',
      agentId: 'codex-luna-max',
      pid: 16924,
      startTime: '2026-09-05T00:00:00.000Z',
      exitCode: 0,
      abnormal: false,
    }, { nowFn: () => '2026-09-05T00:12:00.000Z' });

    assert.equal(result.ok, true);
    const expectedPath = recordPath(workspace, {
      ownerKind: 'issue', ownerId: 450, artifact: ARTIFACTS.CYCLE_METRICS,
    });
    assert.equal(result.path, expectedPath);
    assert.equal(fs.existsSync(expectedPath), true);
    const events = metrics.readCycleEvents(workspace, 450);
    assert.deepEqual(events[0], {
      schemaVersion: 1,
      issue: 450,
      event: 'worker-stopped',
      at: '2026-09-05T00:12:00.000Z',
      workerName: 'issue-450-senior-coder-cycle-metrics',
      role: 'senior-coder',
      agentId: 'codex-luna-max',
      pid: 16924,
      startTime: '2026-09-05T00:00:00.000Z',
      exitCode: 0,
      abnormal: false,
    });
  } finally {
    cleanup(workspace);
  }
});

test('readCycleEvents: 壊れた行と別Issueの行を隠さず無視する', () => {
  const workspace = tempWorkspace();
  try {
    const filePath = metrics.metricsPath(workspace, 450);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, [
      JSON.stringify({ schemaVersion: 1, issue: 450, event: 'issue-created', at: '2026-09-05T00:00:00Z' }),
      '{broken',
      JSON.stringify({ schemaVersion: 1, issue: 451, event: 'merged', at: '2026-09-05T00:01:00Z' }),
    ].join('\n'), 'utf8');
    assert.deepEqual(metrics.readCycleEvents(workspace, 450).map(item => item.event), ['issue-created']);
  } finally {
    cleanup(workspace);
  }
});

test('projectCycleMetrics: 6区間、停止時間、異常終了の重複を同じrunへ投影する', () => {
  const events = [
    { schemaVersion: 1, issue: 450, event: 'issue-created', at: '2026-09-05T00:00:00Z' },
    { schemaVersion: 1, issue: 450, event: 'worker-started', at: '2026-09-05T00:04:00Z', workerName: 'issue-450-senior-coder-x', role: 'senior-coder', agentId: 'codex', pid: 10, startTime: '2026-09-05T00:04:00Z' },
    { schemaVersion: 1, issue: 450, event: 'worker-stopped', at: '2026-09-05T00:16:00Z', workerName: 'issue-450-senior-coder-x', pid: 10, abnormal: false, exitCode: 0 },
    { schemaVersion: 1, issue: 450, event: 'worker-stopped', at: '2026-09-05T00:16:01Z', workerName: 'issue-450-senior-coder-x', pid: 10, abnormal: true, exitCode: 137 },
    { schemaVersion: 1, issue: 450, event: 'plan-reported', at: '2026-09-05T00:13:00Z' },
    { schemaVersion: 1, issue: 450, event: 'implementation-approved', at: '2026-09-05T00:20:00Z' },
  ];
  const projected = metrics.projectCycleMetrics(events, {
    issue: 450,
    now: Date.parse('2026-09-05T00:30:00Z'),
  });

  assert.equal(projected.intervals.length, 6);
  assert.equal(projected.intervals[0].seconds, 240);
  assert.equal(projected.intervals[1].seconds, 540);
  assert.equal(projected.intervals[2].seconds, 420);
  assert.equal(projected.intervals[3].seconds, null);
  assert.equal(projected.workers.length, 1);
  assert.equal(projected.workers[0].elapsedSeconds, 720);
  assert.equal(projected.workers[0].running, false);
  assert.equal(projected.workers[0].abnormal, true);
});

test('workerProjection: 識別情報のない停止は同名runの直近未停止runへ対応付ける', () => {
  const events = [
    { schemaVersion: 1, issue: 450, event: 'worker-started', at: '2026-09-05T00:00:00Z', workerName: 'issue-450-senior-coder', role: 'senior-coder', agentId: 'codex', pid: 10, startTime: '2026-09-05T00:00:00Z' },
    { schemaVersion: 1, issue: 450, event: 'worker-started', at: '2026-09-05T00:05:00Z', workerName: 'issue-450-senior-coder', role: 'senior-coder', agentId: 'codex', pid: 11, startTime: '2026-09-05T00:05:00Z' },
    { schemaVersion: 1, issue: 450, event: 'worker-stopped', at: '2026-09-05T00:10:00Z', workerName: 'issue-450-senior-coder', exitCode: 0, abnormal: false },
  ];

  const workers = metrics.workerProjection(events, Date.parse('2026-09-05T00:20:00Z'));
  assert.equal(workers.length, 2);
  assert.deepEqual(workers.map(worker => ({ pid: worker.pid, running: worker.running, elapsedSeconds: worker.elapsedSeconds })), [
    { pid: 10, running: true, elapsedSeconds: 1200 },
    { pid: 11, running: false, elapsedSeconds: 300 },
  ]);
});

test('recordCycleEvent: 書き込み失敗は呼び出し元へ投げず引数を保持した失敗結果を返す', () => {
  const calls = [];
  const result = metrics.recordCycleEvent('C:/workspace', 450, 'plan-reported', {}, {
    metricsPathFn: (workspace, issue) => {
      calls.push({ workspace, issue });
      return 'C:/workspace/.gh-maestro/records/issue/450/cycle-metrics.jsonl';
    },
    mkdirFn: () => {},
    appendFileFn: () => { throw new Error('disk full'); },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(calls, [{ workspace: 'C:/workspace', issue: 450 }]);
  assert.match(result.error.message, /disk full/);
});

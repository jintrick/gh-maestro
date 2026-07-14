'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  workersJsonPath,
  readWorkersRaw,
  updateWorkerPaneId,
  getOrchestratorPaneId,
} = require('../scripts/shared/workers-registry');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeWorkers(dir, workers) {
  fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
  fs.writeFileSync(workersJsonPath(dir), JSON.stringify(workers, null, 2), 'utf8');
}

test('readWorkersRaw: ファイルが無ければnull', () => {
  withTempDir((dir) => {
    assert.equal(readWorkersRaw(dir), null);
  });
});

test('readWorkersRaw: 壊れたJSONはnull', () => {
  withTempDir((dir) => {
    fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(workersJsonPath(dir), '{not json', 'utf8');
    assert.equal(readWorkersRaw(dir), null);
  });
});

test('readWorkersRaw: 配列はnull（オブジェクトでない）', () => {
  withTempDir((dir) => {
    fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(workersJsonPath(dir), '[]', 'utf8');
    assert.equal(readWorkersRaw(dir), null);
  });
});

test('readWorkersRaw: 正常なJSONを返す', () => {
  withTempDir((dir) => {
    writeWorkers(dir, { orchestrator: { paneId: '1' } });
    assert.deepEqual(readWorkersRaw(dir), { orchestrator: { paneId: '1' } });
  });
});

test('updateWorkerPaneId: 既存エントリのpaneIdを更新する', () => {
  withTempDir((dir) => {
    writeWorkers(dir, {
      orchestrator: { paneId: '1' },
      'issue-5-fix': { paneId: '10', agentId: 'agy', issue: 5 },
    });

    const ok = updateWorkerPaneId(dir, 'issue-5-fix', '99');
    assert.equal(ok, true);

    const raw = readWorkersRaw(dir);
    assert.equal(raw['issue-5-fix'].paneId, '99');
    assert.equal(raw['issue-5-fix'].agentId, 'agy');
    assert.equal(raw['issue-5-fix'].issue, 5);
    // 他エントリは変化しない
    assert.equal(raw.orchestrator.paneId, '1');
  });
});

test('updateWorkerPaneId: 数値paneIdでも文字列化して保存する', () => {
  withTempDir((dir) => {
    writeWorkers(dir, { 'issue-5-fix': { paneId: '10', agentId: 'agy', issue: 5 } });
    updateWorkerPaneId(dir, 'issue-5-fix', 99);
    const raw = readWorkersRaw(dir);
    assert.equal(raw['issue-5-fix'].paneId, '99');
    assert.equal(typeof raw['issue-5-fix'].paneId, 'string');
  });
});

test('updateWorkerPaneId: 存在しないworkerNameはfalseを返し何も書き換えない', () => {
  withTempDir((dir) => {
    writeWorkers(dir, { 'issue-5-fix': { paneId: '10' } });
    const ok = updateWorkerPaneId(dir, 'issue-999-nope', '99');
    assert.equal(ok, false);
    // 書き込みが行われていないため、raw のファイル内容がそのまま残っている
    assert.deepEqual(readWorkersRaw(dir)['issue-5-fix'], { paneId: '10' });
  });
});

test('updateWorkerPaneId: workers.jsonが無い場合はfalse', () => {
  withTempDir((dir) => {
    assert.equal(updateWorkerPaneId(dir, 'issue-5-fix', '99'), false);
  });
});

test('getOrchestratorPaneId: orchestratorエントリのpaneIdを返す', () => {
  withTempDir((dir) => {
    writeWorkers(dir, { orchestrator: { paneId: '1' } });
    assert.equal(getOrchestratorPaneId(dir), '1');
  });
});

test('getOrchestratorPaneId: orchestratorエントリが無ければnull', () => {
  withTempDir((dir) => {
    writeWorkers(dir, { 'issue-5-fix': { paneId: '10' } });
    assert.equal(getOrchestratorPaneId(dir), null);
  });
});

test('getOrchestratorPaneId: workers.jsonが無ければnull', () => {
  withTempDir((dir) => {
    assert.equal(getOrchestratorPaneId(dir), null);
  });
});

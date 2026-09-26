'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-recovery-runtime-'));
const previousRuntime = process.env.GH_MAESTRO_RUNTIME_DIR;
process.env.GH_MAESTRO_RUNTIME_DIR = runtimeRoot;
const { recoverOrphanedSlowRuns } = require('../scripts/poll-pr');

const workspaces = [];
function workspaceWithState(runs) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-recovery-workspace-'));
  fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.gh-maestro', 'poll-slow-test-42.json'), JSON.stringify({
    schemaVersion: 1,
    pr: '42',
    layer: 'slow',
    runs,
  }), 'utf8');
  workspaces.push(workspace);
  return workspace;
}

after(() => {
  for (const workspace of workspaces) fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
  if (previousRuntime === undefined) delete process.env.GH_MAESTRO_RUNTIME_DIR;
  else process.env.GH_MAESTRO_RUNTIME_DIR = previousRuntime;
});

test('slow workerが消えたrunningレコードはunavailableへ回収する', () => {
  const workspace = workspaceWithState({
    abc: { status: 'running', testedHead: 'abc', pid: 999, startTime: '2026-09-27T00:00:00.000Z' },
  });
  const output = [];
  const events = recoverOrphanedSlowRuns(workspace, {
    isProcessAliveFn: () => false,
    nowFn: () => '2026-09-27T01:00:00.000Z',
    writeStdoutFn: (line) => output.push(line),
  });
  const state = JSON.parse(fs.readFileSync(path.join(workspace, '.gh-maestro', 'poll-slow-test-42.json'), 'utf8'));
  assert.equal(events.length, 1);
  assert.equal(state.runs.abc.status, 'unavailable');
  assert.equal(state.runs.abc.result.error, 'slow-worker-exited-without-result');
  assert.match(output[0], /SLOW_TEST_RESULT:/);
});

test('壊れたslow stateは対象なしへ縮退せずファイルを示して停止する', () => {
  const workspace = workspaceWithState({});
  const statePath = path.join(workspace, '.gh-maestro', 'poll-slow-test-42.json');
  fs.writeFileSync(statePath, '{broken', 'utf8');
  assert.throws(
    () => recoverOrphanedSlowRuns(workspace),
    (error) => error.message.includes(statePath),
  );
});

test('PIDが生きていても起動時刻が違えばrunningを残さない', () => {
  const workspace = workspaceWithState({
    abc: { status: 'running', testedHead: 'abc', pid: 999, startTime: '2026-09-27T00:00:00.000Z' },
  });
  recoverOrphanedSlowRuns(workspace, {
    isProcessAliveFn: () => true,
    getProcessStartTimeFn: () => '2026-09-27T02:00:00.000Z',
    writeStdoutFn: () => {},
  });
  const state = JSON.parse(fs.readFileSync(path.join(workspace, '.gh-maestro', 'poll-slow-test-42.json'), 'utf8'));
  assert.equal(state.runs.abc.status, 'unavailable');
  assert.equal(state.runs.abc.result.error, 'slow-worker-identity-mismatch');
});

test('回収対象のworktreeとIssue情報が残っていればunavailable層を申告する', () => {
  const workspace = workspaceWithState({
    abc: { status: 'running', testedHead: 'abc', pid: 999, startTime: '2026-09-27T00:00:00.000Z' },
  });
  const statePath = path.join(workspace, '.gh-maestro', 'poll-slow-test-42.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.issue = '581';
  state.repo = 'fixture/repo';
  state.runs.abc.worktree = workspace;
  fs.writeFileSync(statePath, JSON.stringify(state), 'utf8');

  const declarations = [];
  recoverOrphanedSlowRuns(workspace, {
    isProcessAliveFn: () => false,
    getPrHeadFn: () => 'abc',
    declareTestResultFn: (args) => {
      declarations.push(args);
      return { ok: true };
    },
    writeStdoutFn: () => {},
  });

  const recovered = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(recovered.runs.abc.status, 'unavailable');
  assert.equal(recovered.runs.abc.declaration, 'updated');
  assert.equal(recovered.runs.abc.result.declaration, 'updated');
  assert.equal(declarations.length, 1);
  assert.equal(declarations[0].headSha, 'abc');
});

test('PIDと起動時刻が一致するslow workerはrunningのまま待つ', () => {
  const workspace = workspaceWithState({
    abc: { status: 'running', testedHead: 'abc', pid: 999, startTime: '2026-09-27T00:00:00.000Z' },
  });
  const events = recoverOrphanedSlowRuns(workspace, {
    isProcessAliveFn: () => true,
    getProcessStartTimeFn: () => '2026-09-27T00:00:00.500Z',
    writeStdoutFn: () => {},
  });
  const state = JSON.parse(fs.readFileSync(path.join(workspace, '.gh-maestro', 'poll-slow-test-42.json'), 'utf8'));
  assert.deepEqual(events, []);
  assert.equal(state.runs.abc.status, 'running');
});

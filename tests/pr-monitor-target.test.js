'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-target-runtime-'));
const previousRuntime = process.env.GH_MAESTRO_RUNTIME_DIR;
process.env.GH_MAESTRO_RUNTIME_DIR = runtimeRoot;

const {
  targetPath,
  createPrMonitorTarget,
  readPrMonitorTarget,
  writePrMonitorTarget,
  clearPrMonitorTarget,
} = require('../scripts/shared/pr-monitor-target');

const workspaces = [];
function makeWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-target-workspace-'));
  fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
  workspaces.push(workspace);
  return workspace;
}

after(() => {
  for (const workspace of workspaces) fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
  if (previousRuntime === undefined) delete process.env.GH_MAESTRO_RUNTIME_DIR;
  else process.env.GH_MAESTRO_RUNTIME_DIR = previousRuntime;
});

test('PR monitor target はruntimeへ原子的に保存し、同じ値を読み戻す', () => {
  const workspace = makeWorkspace();
  const target = createPrMonitorTarget({
    issue: '581',
    baseBranch: 'dev',
    noReviewManager: true,
    sessionPid: 1234,
    sessionStartTime: '2026-09-27T00:00:00.000Z',
  });
  writePrMonitorTarget(workspace, target);

  assert.equal(readPrMonitorTarget(workspace).issue, '581');
  assert.equal(readPrMonitorTarget(workspace).baseBranch, 'dev');
  assert.equal(readPrMonitorTarget(workspace).noReviewManager, true);
  assert.ok(targetPath(workspace).startsWith(runtimeRoot));
  assert.ok(!targetPath(workspace).startsWith(path.join(workspace, '.gh-maestro')));
});

test('PR monitor target が無い場合だけnullを返す', () => {
  const workspace = makeWorkspace();
  assert.equal(readPrMonitorTarget(workspace), null);
});

test('PR monitor target の破損JSONは不在へ縮退しない', () => {
  const workspace = makeWorkspace();
  const filePath = targetPath(workspace);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '{broken', 'utf8');
  assert.throws(() => readPrMonitorTarget(workspace), /読み取れません/);
});

test('clear はIssueとgenerationを照合し、新しいtargetを誤削除しない', () => {
  const workspace = makeWorkspace();
  const first = createPrMonitorTarget({ issue: 581, generation: 'first' });
  writePrMonitorTarget(workspace, first);
  assert.equal(clearPrMonitorTarget(workspace, { issue: 580 }), false);
  assert.equal(readPrMonitorTarget(workspace).generation, 'first');
  assert.equal(clearPrMonitorTarget(workspace, { issue: 581, generation: 'other' }), false);
  assert.equal(clearPrMonitorTarget(workspace, { issue: 581, generation: 'first' }), true);
  assert.equal(readPrMonitorTarget(workspace), null);
});

test('target の型不正は書き込み時に拒否する', () => {
  const workspace = makeWorkspace();
  assert.throws(() => writePrMonitorTarget(workspace, {
    schemaVersion: 1,
    generation: 'bad',
    issue: '581',
    baseBranch: null,
    noReviewManager: 'false',
    noReviewEvents: false,
    sessionPid: null,
    sessionStartTime: null,
    updatedAt: new Date().toISOString(),
  }), /フィールドが不正/);
});

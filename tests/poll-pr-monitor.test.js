'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const monitor = require('../scripts/poll-pr-monitor');

function target(generation, overrides = {}) {
  return {
    schemaVersion: 1,
    generation,
    issue: '581',
    baseBranch: 'dev',
    noReviewManager: false,
    noReviewEvents: false,
    sessionPid: 123,
    sessionStartTime: null,
    updatedAt: '2026-09-27T00:00:00.000Z',
    ...overrides,
  };
}

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

test('childArguments はtargetの可変値をpoll-pr.jsのargvへ変換する', () => {
  const args = monitor.childArguments(target('g1', {
    issue: '42',
    noReviewManager: true,
    noReviewEvents: true,
  }), 'C:/workspace', 99);
  assert.equal(args[0], path.join(__dirname, '..', 'scripts', 'poll-pr.js'));
  assert.deepEqual(args.slice(1), [
    '42', '--workspace', 'C:/workspace', '--plugin-monitor',
    '--session-pid', '99', '--base-branch', 'dev',
    '--no-review-manager', '--no-review-events',
  ]);
});

test('同じgenerationのpoll-prは終了しても再試行しない', async () => {
  const children = [];
  const targetValue = target('same');
  const result = await monitor.runPrMonitor({ workspace: 'C:/workspace' }, {
    readTargetFn: () => targetValue,
    resolveSessionPidFn: () => 99,
    expectedStartTime: null,
    checkSessionFn: () => true,
    sleepFn: async () => {
      const child = children[0];
      if (child && !child.exitCode) {
        child.exitCode = 0;
        child.emit('close', 0);
      }
    },
    maxIterations: 3,
    spawnFn: (command, args, options) => {
      const child = fakeChild(501);
      children.push(child);
      return child;
    },
    waitForChildCloseFn: async () => {},
    recoverOrphanedSlowRunsFn: () => [],
  });
  assert.equal(result.exitCode, 0);
  assert.equal(children.length, 1);
});

test('poll-pr異常終了は通知して同じgenerationを再試行しない', async () => {
  const children = [];
  const errors = [];
  const targetValue = target('failed-generation');
  const result = await monitor.runPrMonitor({ workspace: 'C:/workspace' }, {
    readTargetFn: () => targetValue,
    resolveSessionPidFn: () => 99,
    expectedStartTime: null,
    checkSessionFn: () => true,
    sleepFn: async () => {
      const child = children[0];
      if (child && child.exitCode === null) {
        child.exitCode = 7;
        child.emit('close', 7);
      }
    },
    maxIterations: 3,
    spawnFn: () => {
      const child = fakeChild(503);
      children.push(child);
      return child;
    },
    waitForChildCloseFn: async () => {},
    recoverOrphanedSlowRunsFn: () => [],
    writeStderrFn: (message) => errors.push(message),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(children.length, 1);
  assert.ok(errors.some((message) => message.includes('code=7')));
  assert.ok(errors.some((message) => message.includes('自動再試行しません')));
});

test('targetを消すとpoll-prのprocess treeを停止しslow回収を一度行う', async () => {
  const child = fakeChild(502);
  const targets = [target('g1'), null, null];
  const recoveries = [];
  let reads = 0;
  let killedPid = null;
  await monitor.runPrMonitor({ workspace: 'C:/workspace' }, {
    readTargetFn: () => targets[Math.min(reads++, targets.length - 1)],
    resolveSessionPidFn: () => 99,
    expectedStartTime: null,
    checkSessionFn: () => true,
    sleepFn: async () => {},
    maxIterations: 3,
    spawnFn: () => child,
    killProcessTreeFn: (pid) => { killedPid = pid; child.exitCode = 0; child.emit('close', 0); },
    waitForChildCloseFn: async () => {},
    recoverOrphanedSlowRunsFn: (workspace, deps) => {
      recoveries.push(workspace);
      return [];
    },
  });
  assert.equal(killedPid, 502);
  assert.deepEqual(recoveries, ['C:/workspace']);
});

test('poll-pr-monitor の引数エラーはCLI境界で非ゼロ終了する', () => {
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'poll-pr-monitor.js'), '--unknown',
  ], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /未知のフラグ/);
});

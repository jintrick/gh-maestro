'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const monitor = require('../scripts/poll-pr-monitor');
const { recoverOrphanedSlowRuns } = require('../scripts/poll-pr');

const recoveryRuntime = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-monitor-recovery-runtime-'));
const previousRuntime = process.env.GH_MAESTRO_RUNTIME_DIR;
process.env.GH_MAESTRO_RUNTIME_DIR = recoveryRuntime;
after(() => {
  fs.rmSync(recoveryRuntime, { recursive: true, force: true });
  if (previousRuntime === undefined) delete process.env.GH_MAESTRO_RUNTIME_DIR;
  else process.env.GH_MAESTRO_RUNTIME_DIR = previousRuntime;
});

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

test('spawnTarget はpoll-pr.jsのstdout/stderrをmonitorへ中継する', async () => {
  const child = fakeChild(504);
  const stdout = [];
  const stderr = [];
  const active = monitor.spawnTarget(target('relay'), 'C:/workspace', 99, {
    spawnFn: () => child,
    writeStdoutFn: (chunk) => stdout.push(String(chunk)),
    writeStderrFn: (chunk) => stderr.push(String(chunk)),
  });

  child.stdout.write('PR_DETECTED:42\n');
  child.stderr.write('poll-pr warning\n');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(active.child, child);
  assert.deepEqual(stdout, ['PR_DETECTED:42\n']);
  assert.deepEqual(stderr, ['poll-pr warning\n']);
});

test('spawnTarget はtargetに残った旧sessionPidではなく現在のmonitor PIDを渡す', async () => {
  const child = fakeChild(505);
  let spawnedArgs;
  await monitor.runPrMonitor({ workspace: 'C:/workspace' }, {
    readTargetFn: () => target('reopened', { sessionPid: 123 }),
    resolveSessionPidFn: () => 999,
    expectedStartTime: null,
    checkSessionFn: () => true,
    maxIterations: 1,
    sleepFn: async () => {},
    spawnFn: (command, args) => {
      spawnedArgs = args;
      return child;
    },
    killProcessTreeFn: () => {},
    waitForChildCloseFn: async () => {},
    recoverOrphanedSlowRunsFn: () => [],
  });
  const sessionPidIndex = spawnedArgs.indexOf('--session-pid');
  assert.deepEqual(spawnedArgs.slice(sessionPidIndex, sessionPidIndex + 2), ['--session-pid', '999']);
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
    maxIterations: 2,
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

test('停止に失敗してslowが後から終了しても、monitorがrunning stateをunavailableへ回収する', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-monitor-recovery-workspace-'));
  fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
  const statePath = path.join(workspace, '.gh-maestro', 'poll-slow-test-581.json');
  fs.writeFileSync(statePath, JSON.stringify({
    schemaVersion: 1,
    issue: '581',
    repo: 'fixture/repo',
    runs: {
      abc: {
        status: 'running',
        testedHead: 'abc',
        pid: 999,
        startTime: '2026-09-27T00:00:00.000Z',
      },
    },
  }), 'utf8');

  const children = [fakeChild(506), fakeChild(507)];
  const targets = [target('g1'), target('g1'), target('g2'), null, null, null];
  const stderr = [];
  const stdout = [];
  let reads = 0;
  let sleeps = 0;
  let slowAlive = true;
  try {
    await monitor.runPrMonitor({ workspace }, {
      readTargetFn: () => targets[Math.min(reads++, targets.length - 1)],
      resolveSessionPidFn: () => 9999,
      expectedStartTime: null,
      checkSessionFn: () => true,
      maxIterations: 5,
      sleepFn: async () => {
        sleeps += 1;
        if (sleeps === 1) {
          children[0].exitCode = 7;
          children[0].emit('close', 7);
        }
        // g2を停止する時点ではまだslowが生きており、その後の周回で終了させる。
        if (sleeps === 4) slowAlive = false;
      },
      spawnFn: () => children.shift(),
      killProcessTreeFn: () => { throw new Error('simulated stop failure'); },
      waitForChildCloseFn: async () => {},
      recoverOrphanedSlowRunsFn: (recoveryWorkspace, deps) => recoverOrphanedSlowRuns(recoveryWorkspace, {
        ...deps,
        isProcessAliveFn: () => slowAlive,
        getProcessStartTimeFn: () => '2026-09-27T00:00:00.000Z',
        startTimesMatchFn: () => true,
      }),
      writeStdoutFn: (chunk) => stdout.push(String(chunk)),
      writeStderrFn: (chunk) => stderr.push(String(chunk)),
    });

    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(state.runs.abc.status, 'unavailable');
    assert.ok(stdout.some((line) => line.includes('SLOW_TEST_RESULT:')));
    assert.ok(stderr.some((line) => line.includes('停止に失敗しました')));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('poll-pr-monitor の引数エラーはCLI境界で非ゼロ終了する', () => {
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'poll-pr-monitor.js'), '--unknown',
  ], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /未知のフラグ/);
});

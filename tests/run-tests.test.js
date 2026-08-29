'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

const {
  SUITES,
  USAGE,
  runTests,
  main,
} = require('../scripts/run-tests');

const SHA = '0123456789abcdef0123456789abcdef01234567';
const CONTENT_HASH = 'a'.repeat(64);

function tempWorktree() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-run-tests-'));
}

function tapSummary({ tests, pass, fail, cancelled = 0, skipped = 0, todo = 0 }) {
  return `# tests ${tests}\n# pass ${pass}\n# fail ${fail}\n# cancelled ${cancelled}\n# skipped ${skipped}\n# todo ${todo}\n`;
}

function runWithChild({ suite = 'full', child, writeArtifactFn, extraDeps = {} }) {
  const stdout = [];
  const stderr = [];
  const calls = [];
  const artifacts = [];
  const result = runTests(
    { suite, cwd: tempWorktree(), env: { TEST_RUNNER_FIXTURE: '1' } },
    {
      clearArtifactFn: (worktree) => calls.push({ type: 'clear', worktree }),
      resolveGitHeadFn: (worktree) => {
        calls.push({ type: 'head', worktree });
        return SHA;
      },
      calculateWorktreeContentHashFn: () => CONTENT_HASH,
      spawnSyncFn: (command, args, options) => {
        calls.push({ type: 'spawn', command, args, options });
        return child;
      },
      writeArtifactFn: writeArtifactFn || ((_worktree, artifact) => artifacts.push(artifact)),
      writeStdoutFn: (value) => stdout.push(value),
      writeStderrFn: (value) => stderr.push(value),
      ...extraDeps,
    },
  );
  return { result, calls, artifacts, stdout: stdout.join(''), stderr: stderr.join('') };
}

test('runTests: full suiteを一度だけ起動し、成功結果をfullとして保存する', () => {
  const fixture = runWithChild({
    child: { status: 0, stdout: `TAP version 13\n${tapSummary({ tests: 5, pass: 5, fail: 0 })}`, stderr: '' },
  });

  assert.equal(fixture.result.exitCode, 0);
  assert.equal(fixture.result.artifactWritten, true);
  assert.equal(fixture.artifacts.length, 1);
  assert.equal(fixture.artifacts[0].scope, 'full');
  assert.equal(fixture.artifacts[0].status, 'complete');
  assert.equal(fixture.artifacts[0].tests, 5);
  assert.equal(fixture.artifacts[0].pass, 5);
  assert.equal(fixture.artifacts[0].fail, 0);
  assert.equal(fixture.artifacts[0].testedHead, SHA);
  assert.equal(fixture.artifacts[0].testedContentHash, CONTENT_HASH);
  assert.equal(fixture.calls.filter((call) => call.type === 'spawn').length, 1);
  const spawnCall = fixture.calls.find((call) => call.type === 'spawn');
  assert.equal(spawnCall.command, process.execPath);
  assert.deepEqual(spawnCall.args, SUITES.full.testArgs);
  assert.match(fixture.stdout, /# tests 5/);
});

test('runTests: runnerが赤でもsummaryを保存し、runnerの終了コードを返す', () => {
  const fixture = runWithChild({
    child: { status: 1, stdout: tapSummary({ tests: 4, pass: 3, fail: 1 }), stderr: 'not ok 4 - failure\n' },
  });

  assert.equal(fixture.result.exitCode, 1);
  assert.equal(fixture.artifacts[0].status, 'complete');
  assert.equal(fixture.artifacts[0].fail, 1);
  assert.equal(fixture.artifacts[0].pass, 3);
  assert.match(fixture.stdout, /not ok|# tests/);
});

test('runTests: slow suiteはpartialとして記録する', () => {
  const fixture = runWithChild({
    suite: 'slow',
    child: { status: 0, stdout: tapSummary({ tests: 2, pass: 2, fail: 0 }), stderr: '' },
  });

  assert.equal(fixture.result.exitCode, 0);
  assert.equal(fixture.artifacts[0].scope, 'partial');
  assert.equal(fixture.artifacts[0].command, 'npm run test:slow');
  const spawnCall = fixture.calls.find((call) => call.type === 'spawn');
  assert.deepEqual(spawnCall.args, SUITES.slow.testArgs);
});

test('runTests: summaryが欠落した場合はunavailable成果物を作る', () => {
  const fixture = runWithChild({
    child: { status: 1, stdout: 'runner crashed before TAP summary\n', stderr: 'fatal\n' },
  });

  assert.equal(fixture.result.exitCode, 1);
  assert.equal(fixture.artifacts[0].status, 'unavailable');
  assert.equal(fixture.artifacts[0].reason, 'tap-summary-invalid');
});

test('runTests: runner起動失敗もunavailableとして記録し、終了コード1を返す', () => {
  const fixture = runWithChild({
    child: { status: null, error: new Error('node executable missing'), stdout: '', stderr: '' },
  });

  assert.equal(fixture.result.exitCode, 1);
  assert.equal(fixture.artifacts[0].status, 'unavailable');
  assert.equal(fixture.artifacts[0].reason, 'runner-start-failed');
});

test('runTests: 成果物の書き出し失敗はrunner結果を隠さず、申告側にunknownを残す', () => {
  const fixture = runWithChild({
    child: { status: 0, stdout: tapSummary({ tests: 1, pass: 1, fail: 0 }), stderr: '' },
    writeArtifactFn: () => { throw new Error('runtime root unavailable'); },
  });

  assert.equal(fixture.result.exitCode, 0);
  assert.equal(fixture.result.artifactWritten, false);
  assert.match(fixture.stderr, /runtime root unavailable/);
});

test('runTests: テスト対象内容の指紋取得失敗はunavailableとして記録する', () => {
  const fixture = runWithChild({
    child: { status: 0, stdout: tapSummary({ tests: 1, pass: 1, fail: 0 }), stderr: '' },
    extraDeps: {
      calculateWorktreeContentHashFn: () => { throw new Error('worktree snapshot failed'); },
    },
  });

  assert.equal(fixture.result.exitCode, 0);
  assert.equal(fixture.artifacts[0].status, 'unavailable');
  assert.equal(fixture.artifacts[0].reason, 'content-snapshot-failed');
  assert.match(fixture.stderr, /worktree snapshot failed/);
});

test('runTests: 未知のsuiteはrunnerを起動せずエラーにする', () => {
  let spawned = false;
  const result = runTests(
    { suite: 'unknown', cwd: tempWorktree(), env: {} },
    { spawnSyncFn: () => { spawned = true; return { status: 0 }; } },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(spawned, false);
  assert.match(result.stderr, /未知のテストスイート/);
});

test('main: --helpは実runnerを起動せずusageを返す', () => {
  const result = main(['--help']);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, USAGE);
});

test('main: 未知のsuiteはエラーをstderrへ返す', () => {
  const result = main(['unknown']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /未知のテストスイート/);
});

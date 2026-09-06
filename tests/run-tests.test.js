'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

const {
  USAGE,
  runTests,
  main,
} = require('../scripts/run-tests');
const { createBuiltinTestConfig } = require('../scripts/shared/resolve-config');

const BUILTIN_TEST_LAYERS = createBuiltinTestConfig().layers;

const SHA = '0123456789abcdef0123456789abcdef01234567';
const CONTENT_HASH = 'a'.repeat(64);

function tempWorktree() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-run-tests-'));
}

function tapSummary({ tests, pass, fail, cancelled = 0, skipped = 0, todo = 0 }) {
  return `# tests ${tests}\n# pass ${pass}\n# fail ${fail}\n# cancelled ${cancelled}\n# skipped ${skipped}\n# todo ${todo}\n`;
}

function runWithChild({ suite = 'full', layer, testFiles = [], changedFiles = [], child, writeArtifactFn,
  cwd = tempWorktree(), workspace, extraDeps = {} }) {
  const stdout = [];
  const stderr = [];
  const calls = [];
  const artifacts = [];
  const invalidations = [];
  const writes = [];
  const result = runTests(
    {
      suite,
      layer,
      testFiles,
      changedFiles,
      cwd,
      workspace,
      env: { TEST_RUNNER_FIXTURE: '1' },
    },
    {
      clearArtifactFn: (worktree) => calls.push({ type: 'clear', worktree }),
      resolveGitHeadFn: (worktree) => {
        calls.push({ type: 'head', worktree });
        return SHA;
      },
      calculateWorktreeContentHashFn: (worktree) => {
        calls.push({ type: 'hash', worktree });
        return CONTENT_HASH;
      },
      spawnSyncFn: (command, args, options) => {
        calls.push({ type: 'spawn', command, args, options });
        return child;
      },
      invalidateArtifactFn: (worktree, reason) => invalidations.push({ worktree, reason }),
      writeArtifactFn: writeArtifactFn || ((worktree, artifact) => {
        writes.push({ worktree, artifact });
        artifacts.push(artifact);
      }),
      writeStdoutFn: (value) => stdout.push(value),
      writeStderrFn: (value) => stderr.push(value),
      ...extraDeps,
    },
  );
  return {
    result,
    calls,
    artifacts,
    invalidations,
    writes,
    stdout: stdout.join(''),
    stderr: stderr.join(''),
  };
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
  assert.equal(fixture.artifacts[0].outcome, 'pass');
  assert.equal(fixture.artifacts[0].tests, 5);
  assert.equal(fixture.artifacts[0].pass, 5);
  assert.equal(fixture.artifacts[0].fail, 0);
  assert.equal(fixture.artifacts[0].testedHead, SHA);
  assert.equal(fixture.artifacts[0].testedContentHash, CONTENT_HASH);
  assert.equal(fixture.calls.filter((call) => call.type === 'spawn').length, 1);
  const spawnCall = fixture.calls.find((call) => call.type === 'spawn');
  assert.equal(spawnCall.command, process.execPath);
  assert.deepEqual(spawnCall.args, [
    ...BUILTIN_TEST_LAYERS.full.command.slice(1),
    ...BUILTIN_TEST_LAYERS.full.defaultTestFiles,
  ]);
  assert.match(fixture.stdout, /# tests 5/);
});

test('runTests: runnerが赤でもsummaryを保存し、runnerの終了コードを返す', () => {
  const fixture = runWithChild({
    child: { status: 1, stdout: tapSummary({ tests: 4, pass: 3, fail: 1 }), stderr: 'not ok 4 - failure\n' },
  });

  assert.equal(fixture.result.exitCode, 1);
  assert.equal(fixture.artifacts[0].status, 'complete');
  assert.equal(fixture.artifacts[0].outcome, 'fail');
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
  assert.deepEqual(spawnCall.args, [
    ...BUILTIN_TEST_LAYERS.slow.command.slice(1),
    ...BUILTIN_TEST_LAYERS.slow.defaultTestFiles,
  ]);
});

test('runTests: slow suiteは指定された分離側テストだけを起動する', () => {
  const testFiles = ['tests/slow/process-lifecycle.test.js', 'tests/slow/config.test.js'];
  const fixture = runWithChild({
    suite: 'slow',
    testFiles,
    child: { status: 0, stdout: tapSummary({ tests: 2, pass: 2, fail: 0 }), stderr: '' },
  });

  const spawnCall = fixture.calls.find((call) => call.type === 'spawn');
  assert.deepEqual(spawnCall.args, [
    ...BUILTIN_TEST_LAYERS.slow.command.slice(1),
    ...testFiles,
  ]);
  assert.equal(fixture.artifacts[0].scope, 'partial');
  assert.equal(fixture.artifacts[0].command, 'npm run test:slow');
});

test('runTests: slow suiteの個別指定はtests/slow直下以外を起動しない', () => {
  for (const testFiles of [
    ['tests/process-lifecycle.test.js'],
    ['tests/slow/../process-lifecycle.test.js'],
    ['C:/repo/tests/slow/process-lifecycle.test.js'],
  ]) {
    let spawned = false;
    const result = runTests(
      { suite: 'slow', testFiles, cwd: tempWorktree(), env: {} },
      { spawnSyncFn: () => { spawned = true; return { status: 0 }; } },
    );
    assert.equal(result.exitCode, 1);
    assert.equal(result.artifact, null);
    assert.equal(spawned, false);
    assert.match(result.stderr, /tests\/slow\/\<name\>\.test\.js/);
  }
});

test('runTests: full suiteへの個別ファイル指定は起動しない', () => {
  let spawned = false;
  const result = runTests(
    { suite: 'full', testFiles: ['tests/slow/process-lifecycle.test.js'], cwd: tempWorktree(), env: {} },
    { spawnSyncFn: () => { spawned = true; return { status: 0 }; } },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.artifact, null);
  assert.equal(spawned, false);
  assert.match(result.stderr, /partial 層/);
});

test('runTests: summaryが欠落しても終了コード0なら件数なしのpass成果物を作る', () => {
  const fixture = runWithChild({
    child: { status: 0, stdout: 'runner does not emit TAP\n', stderr: '' },
  });

  assert.equal(fixture.result.exitCode, 0);
  assert.equal(fixture.artifacts[0].status, 'complete');
  assert.equal(fixture.artifacts[0].outcome, 'pass');
  assert.equal('tests' in fixture.artifacts[0], false);
  assert.equal('pass' in fixture.artifacts[0], false);
  assert.equal('fail' in fixture.artifacts[0], false);

  const failed = runWithChild({
    child: { status: 3, stdout: 'runner reports failure in its own format\n', stderr: '' },
  });
  assert.equal(failed.result.exitCode, 3);
  assert.equal(failed.artifacts[0].status, 'complete');
  assert.equal(failed.artifacts[0].outcome, 'fail');
  assert.equal('tests' in failed.artifacts[0], false);
  assert.equal('pass' in failed.artifacts[0], false);
  assert.equal('fail' in failed.artifacts[0], false);

  const inconsistentSummary = runWithChild({
    child: { status: 0, stdout: tapSummary({ tests: 2, pass: 2, fail: 1 }), stderr: '' },
  });
  assert.equal(inconsistentSummary.result.exitCode, 0);
  assert.equal(inconsistentSummary.artifacts[0].outcome, 'pass');
  assert.equal('tests' in inconsistentSummary.artifacts[0], false);
});

test('runTests: runner起動失敗もunavailableとして記録し、終了コード1を返す', () => {
  const fixture = runWithChild({
    child: { status: null, error: new Error('node executable missing'), stdout: '', stderr: '' },
  });

  assert.equal(fixture.result.exitCode, 1);
  assert.equal(fixture.artifacts[0].status, 'unavailable');
  assert.equal(fixture.artifacts[0].reason, 'runner-start-failed');
});

test('runTests: 成果物の削除・書き出し失敗はrunner結果を隠さず、unknownマーカーを残す', () => {
  const cleared = runWithChild({
    child: { status: 0, stdout: '', stderr: '' },
    extraDeps: {
      clearArtifactFn: () => { throw new Error('old artifact locked'); },
    },
  });
  assert.equal(cleared.result.exitCode, 1);
  assert.equal(cleared.result.artifact, null);
  assert.equal(cleared.calls.some((call) => call.type === 'spawn'), false);
  assert.deepEqual(cleared.invalidations.map((entry) => entry.reason), ['artifact-clear-failed']);
  assert.match(cleared.stderr, /old artifact locked/);

  const fixture = runWithChild({
    child: { status: 0, stdout: tapSummary({ tests: 1, pass: 1, fail: 0 }), stderr: '' },
    writeArtifactFn: () => { throw new Error('runtime root unavailable'); },
  });

  assert.equal(fixture.result.exitCode, 0);
  assert.equal(fixture.result.artifactWritten, false);
  assert.deepEqual(fixture.invalidations.map((entry) => entry.reason), ['artifact-write-failed']);
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

test('runTests: 未知のsuiteを拒否し、宣言されたargv/mapping/fallbackを使う', () => {
  let spawned = false;
  const result = runTests(
    { suite: 'unknown', cwd: tempWorktree(), env: {} },
    { spawnSyncFn: () => { spawned = true; return { status: 0 }; } },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(spawned, false);
  assert.match(result.stderr, /未知のテストスイート/);

  const custom = runWithChild({
    layer: 'every',
    child: { status: 0, stdout: 'custom runner passed\n', stderr: '' },
    extraDeps: {
      resolveTestConfigFn: () => ({
        source: 'declared',
        layers: {
          every: { scope: 'full', command: ['custom-runner', '--ci', 'value with spaces'] },
        },
      }),
    },
  });
  const customCall = custom.calls.find((call) => call.type === 'spawn');
  assert.equal(customCall.command, 'custom-runner');
  assert.deepEqual(customCall.args, ['--ci', 'value with spaces']);
  assert.equal(customCall.options.shell, false);
  assert.equal(custom.artifacts[0].outcome, 'pass');

  const partial = runWithChild({
    layer: 'changed',
    changedFiles: ['src/widget.js'],
    child: { status: 0, stdout: 'partial runner passed\n', stderr: '' },
    extraDeps: {
      resolveTestConfigFn: () => ({
        source: 'declared',
        layers: {
          changed: {
            scope: 'partial',
            command: ['partial-runner', '--partial'],
            fileArgs: ['--files'],
            mapping: [{ changed: 'src/<name>.js', test: 'checks/<name>.test.js' }],
          },
        },
      }),
    },
  });
  const partialCall = partial.calls.find((call) => call.type === 'spawn');
  assert.equal(partialCall.command, 'partial-runner');
  assert.deepEqual(partialCall.args, ['--partial', '--files', 'checks/widget.test.js']);
  assert.equal(partial.artifacts[0].scope, 'partial');

  const fallback = runWithChild({
    layer: 'changed',
    changedFiles: ['docs/readme.md'],
    child: { status: 0, stdout: 'full runner passed\n', stderr: '' },
    extraDeps: {
      resolveTestConfigFn: () => ({
        source: 'declared',
        layers: {
          every: { scope: 'full', command: ['full-runner', '--all'] },
          changed: {
            scope: 'partial',
            command: ['partial-runner', '--changed'],
            mapping: [{ changed: 'src/<name>.js', test: 'checks/<name>.test.js' }],
          },
        },
      }),
    },
  });
  const fallbackCall = fallback.calls.find((call) => call.type === 'spawn');
  assert.equal(fallbackCall.command, 'full-runner');
  assert.deepEqual(fallbackCall.args, ['--all']);
  assert.equal(fallback.artifacts[0].scope, 'full');

  const caller = tempWorktree();
  const project = tempWorktree();
  const workspace = runWithChild({
    cwd: caller,
    workspace: project,
    child: { status: 0, stdout: '', stderr: '' },
  });
  assert.deepEqual(
    workspace.calls.filter((call) => ['clear', 'head', 'hash'].includes(call.type))
      .map((call) => call.worktree),
    [project, project, project],
  );
  assert.equal(workspace.calls.find((call) => call.type === 'spawn').options.cwd, project);
  assert.equal(workspace.writes[0].worktree, project);
});

test('main: --helpは実runnerを起動せずusageを返す', () => {
  const result = main(['--help']);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, USAGE);

  const calls = [];
  const changed = main(['--changed', 'changed', 'src/widget.js'], {
    resolveTestConfigFn: () => ({
      source: 'declared',
      layers: {
        every: { scope: 'full', command: ['full-runner'] },
        changed: {
          scope: 'partial',
          command: ['partial-runner', '--partial'],
          mapping: [{ changed: 'src/<name>.js', test: 'checks/<name>.test.js' }],
        },
      },
    }),
    clearArtifactFn: () => {},
    resolveGitHeadFn: () => SHA,
    calculateWorktreeContentHashFn: () => CONTENT_HASH,
    spawnSyncFn: (command, args) => {
      calls.push({ command, args });
      return { status: 0, stdout: '', stderr: '' };
    },
    writeArtifactFn: () => {},
  });
  assert.equal(changed.exitCode, 0);
  assert.deepEqual(calls, [{
    command: 'partial-runner',
    args: ['--partial', 'checks/widget.test.js'],
  }]);
});

test('main: 未知のsuiteはエラーをstderrへ返す', () => {
  const result = main(['unknown']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /未知のテストスイート/);
});

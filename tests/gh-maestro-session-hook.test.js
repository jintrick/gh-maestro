'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'gh-maestro-session-hook.js');
const readStateLib = require('../scripts/shared/read-state');

function runGit(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result;
}

function createWorkspace(oldSessionId = 'old-session-id') {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-session-hook-workspace-'));
  runGit(workspace, 'init', '-q');
  runGit(workspace, 'config', 'user.email', 'test@example.com');
  runGit(workspace, 'config', 'user.name', 'gh-maestro test');
  fs.writeFileSync(path.join(workspace, 'README.md'), 'test\n', 'utf8');
  runGit(workspace, 'add', 'README.md');
  runGit(workspace, 'commit', '-qm', 'initial');
  runGit(workspace, 'branch', '-M', 'main');
  runGit(workspace, 'remote', 'add', 'origin', 'https://github.com/example/gh-maestro-test.git');

  fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.gh-maestro', 'setup-ok'), '', 'utf8');
  const initialized = readStateLib.initializeState(workspace, 'orchestrator', {
    sessionId: oldSessionId,
  });
  assert.equal(initialized.ok, true);
  return workspace;
}

function createFakeGh(binDir, { fail = false } = {}) {
  fs.mkdirSync(binDir, { recursive: true });
  const source = [
    "'use strict';",
    `const fail = ${fail ? 'true' : 'false'};`,
    "const path = require('path');",
    "const args = process.argv.slice(1);",
    "if (path.basename(args[0] || '') === 'repo' && args[1] === 'view') {",
    "  if (!fail) {",
    "    process.stdout.write('example/gh-maestro-test\\n');",
    '    process.exit(0);',
    '  }',
    "  process.stderr.write('fake gh failure\\n');",
    '  process.exit(1);',
    '}',
    '',
  ].join('\n');

  const bootstrapPath = path.join(binDir, 'fake-gh-bootstrap.js');
  const ghPath = path.join(binDir, process.platform === 'win32' ? 'gh.exe' : 'gh');
  fs.writeFileSync(bootstrapPath, source, 'utf8');
  // reset-session.js invokes the real executable name `gh` without a shell. A copied
  // Node executable plus NODE_OPTIONS gives the test a cross-platform executable
  // replacement without relying on .cmd/.bat resolution on Windows.
  fs.copyFileSync(process.execPath, ghPath);
  if (process.platform !== 'win32') fs.chmodSync(ghPath, 0o755);
  return bootstrapPath;
}

function hookEnv(binDir, runtimeDir, bootstrapPath) {
  return {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
    GH_MAESTRO_RUNTIME_DIR: runtimeDir,
    ...(bootstrapPath ? { NODE_OPTIONS: `--require=${bootstrapPath}` } : {}),
  };
}

function runHook(workspace, env) {
  return spawnSync(process.execPath, [SCRIPT, '--workspace', workspace], {
    cwd: workspace,
    env,
    encoding: 'utf8',
  });
}

test('runSessionHook: setup → reset-session → get-contextを同期順に実行する', () => {
  const workspace = path.join(os.tmpdir(), 'ghm-session-hook-order-workspace');
  const scriptsDir = path.join(os.tmpdir(), 'ghm-session-hook-scripts');
  const calls = [];

  const result = require('../scripts/gh-maestro-session-hook').runSessionHook(workspace, {
    scriptsDir,
    env: {},
    spawnSyncFn: (command, args, options) => {
      calls.push({ command, args, options });
      return {
        status: 0,
        stdout: `${path.basename(args[0])}\n`,
        stderr: '',
      };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls.map(({ args }) => path.basename(args[0])), [
    'gh-maestro-setup.js',
    'reset-session.js',
    'get-context.js',
  ]);
  assert.deepEqual(calls[0].args.slice(1), [workspace]);
  assert.deepEqual(calls[1].args.slice(1), ['--workspace', workspace, '--quiet']);
  assert.deepEqual(calls[2].args.slice(1), []);
  assert.equal(calls.every(({ command }) => command === process.execPath), true);
  assert.equal(calls.every(({ options }) => options.cwd === workspace), true);
  assert.equal(calls.every(({ options }) => options.env.GH_MAESTRO_WORKSPACE === workspace), true);
  assert.equal(calls.every(({ options }) => options.env.CLAUDE_PROJECT_DIR === workspace), true);
  assert.equal(result.stdout, 'gh-maestro-setup.js\nreset-session.js\nget-context.js\n');
});

test('runSessionHook: stage失敗時は後続を実行せず、捕捉したstdoutを破棄する', () => {
  const calls = [];
  const workspace = path.join(os.tmpdir(), 'ghm-session-hook-failure-workspace');

  const result = require('../scripts/gh-maestro-session-hook').runSessionHook(workspace, {
    spawnSyncFn: (command, args) => {
      calls.push(args[0]);
      if (calls.length === 2) {
        return { status: 1, stdout: 'SESSION_ID=old-session-id\n', stderr: 'reset failed\n' };
      }
      return { status: 0, stdout: 'setup output\n', stderr: '' };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.equal(calls.length, 2, 'stage失敗後にget-contextを実行しないこと');
  assert.equal(result.stdout, '', '失敗時に捕捉済みstdoutを出力しないこと');
  assert.match(result.stderr, /reset-session\.js failed/);
  assert.match(result.stderr, /reset failed/);
  assert.doesNotMatch(result.stderr, /SESSION_ID=old-session-id/);
});

test('CLI通し: 旧sessionIdを置いた一時workspaceでreset後のSESSION_IDだけをcontextへ出力する', () => {
  const workspace = createWorkspace();
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-session-hook-bin-'));
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-session-hook-runtime-'));
  try {
    const bootstrapPath = createFakeGh(binDir);
    const result = runHook(workspace, hookEnv(binDir, runtimeDir, bootstrapPath));

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^SESSION_ID=.+$/m);
    const outputSessionId = result.stdout.match(/^SESSION_ID=(.+)$/m)[1];
    const stateResult = readStateLib.readState(workspace, 'orchestrator');

    assert.equal(stateResult.status, 'ok');
    assert.notEqual(stateResult.state.sessionId, 'old-session-id');
    assert.equal(outputSessionId, stateResult.state.sessionId,
      'get-contextのSESSION_IDはreset後のorchestrator.jsonと一致すること');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('CLI通し: get-contextが失敗した場合は旧SESSION_IDをstdoutへ出力しない', () => {
  const workspace = createWorkspace();
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-session-hook-failing-bin-'));
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-session-hook-failing-runtime-'));
  try {
    const bootstrapPath = createFakeGh(binDir);
    runGit(workspace, 'remote', 'remove', 'origin');
    const result = runHook(workspace, hookEnv(binDir, runtimeDir, bootstrapPath));

    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /SESSION_ID=/,
      'get-context失敗時はreset前後のSESSION_IDを含むstdoutを破棄すること');
    assert.match(result.stderr, /get-context\.js failed/);

    const stateResult = readStateLib.readState(workspace, 'orchestrator');
    assert.equal(stateResult.status, 'ok');
    assert.notEqual(stateResult.state.sessionId, 'old-session-id');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

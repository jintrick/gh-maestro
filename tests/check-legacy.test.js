'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'check-legacy.js');
const checkLegacy = require('../scripts/check-legacy');
const { statusPanePath } = require('../scripts/shared/status-pane-registry');
let cliRuntimeRoot;

before(() => {
  cliRuntimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-check-cli-runtime-'));
});

after(() => {
  if (cliRuntimeRoot) fs.rmSync(cliRuntimeRoot, { recursive: true, force: true });
  cliRuntimeRoot = null;
});

function runCli(...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: { ...process.env, GH_MAESTRO_RUNTIME_DIR: cliRuntimeRoot },
  });
}

test('check-legacy CLI supports --help and -h with exit code 0', () => {
  for (const flag of ['--help', '-h']) {
    const result = runCli(flag);
    assert.equal(result.status, 0, `${flag}: ${result.stderr}`);
    assert.match(result.stdout, /Usage: node check-legacy\.js/);
  }
});

test('check-legacy CLI reports findings with exit code 0', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-check-legacy-workspace-'));
  try {
    fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.gitignore'), '.gh-maestro/\n', 'utf8');
    const statusPane = statusPanePath(workspace, cliRuntimeRoot);
    fs.mkdirSync(path.dirname(statusPane), { recursive: true });
    fs.writeFileSync(statusPane, JSON.stringify({ paneId: 5 }), 'utf8');
    const result = runCli('--workspace', workspace);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    const gitignore = parsed.items.find((entry) => entry.id === 'setup-legacy-gitignore');
    assert.equal(gitignore.status, 'present');
    const legacyStatusPane = parsed.items.find((entry) => entry.id === 'status-pane-legacy-record');
    assert.equal(legacyStatusPane.status, 'present');

    fs.writeFileSync(statusPane, JSON.stringify({
      paneId: '5',
      unixSocket: 'C:\\\\wezterm\\\\test-socket',
      targetPaneId: '1',
    }), 'utf8');
    const current = JSON.parse(runCli('--workspace', workspace).stdout);
    assert.equal(current.items.find((entry) => entry.id === 'status-pane-legacy-record').status, 'absent');

    fs.writeFileSync(statusPane, '{not-json', 'utf8');
    const corrupt = JSON.parse(runCli('--workspace', workspace).stdout);
    assert.notEqual(corrupt.items.find((entry) => entry.id === 'status-pane-legacy-record').status, 'present');

    fs.rmSync(statusPane);
    const missing = JSON.parse(runCli('--workspace', workspace).stdout);
    assert.equal(missing.items.find((entry) => entry.id === 'status-pane-legacy-record').status, 'absent');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('check-legacy CLI rejects invalid argument usage at the child-process boundary', () => {
  const missingValue = runCli('--workspace');
  assert.notEqual(missingValue.status, 0);
  assert.match(missingValue.stderr, /には値が必要です/);

  const unknownFlag = runCli('--not-a-check-legacy-option');
  assert.notEqual(unknownFlag.status, 0);
  assert.match(unknownFlag.stderr, /未知のフラグ/);
});

test('check-legacy main returns nonzero only when inspection cannot execute', () => {
  const stdout = [];
  const stderr = [];
  const code = checkLegacy.main(['--workspace', process.cwd()], {
    inspectFn: () => { throw new Error('fixture inspection failure'); },
    writeStdoutFn: (value) => stdout.push(value),
    writeStderrFn: (value) => stderr.push(value),
  });
  assert.equal(code, 1);
  assert.equal(stdout.join(''), '');
  assert.match(stderr.join(''), /fixture inspection failure/);
});

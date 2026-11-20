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
    // 破損 JSON は present でも absent でもなく unknown として報告する（検出の正しさを status 完全一致で確認）
    assert.equal(corrupt.items.find((entry) => entry.id === 'status-pane-legacy-record').status, 'unknown');

    fs.rmSync(statusPane);
    const missing = JSON.parse(runCli('--workspace', workspace).stdout);
    assert.equal(missing.items.find((entry) => entry.id === 'status-pane-legacy-record').status, 'absent');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
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


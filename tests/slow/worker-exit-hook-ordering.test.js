'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');
const { cleanSpawnEnv } = require('../_spawn-env');

const HOOK_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'worker-exit-hook.js');

function withTempDir(fn) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-exit-hook-order-'));
  try {
    return fn(workspace);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test('実際の非ゼロ終了フックは通知を終えてからmanager.startingを解放する', () => {
  withTempDir((workspace) => {
    const reviewDir = path.join(workspace, '.gh-maestro', 'records', 'pr', '42', 'review');
    fs.mkdirSync(reviewDir, { recursive: true });
    const startupPath = path.join(reviewDir, 'manager.starting');
    fs.writeFileSync(startupPath, JSON.stringify({ token: 'startup-token-42' }), 'utf8');
    const capturePath = path.join(workspace, 'relay-args.json');
    const eventsPath = path.join(workspace, 'hook-events.txt');
    const preloadPath = path.join(workspace, 'capture-relay.js');
    const childProcessModule = require.resolve('../../scripts/shared/child-process');
    fs.writeFileSync(preloadPath, [
      "'use strict';",
      "const fs = require('fs');",
      'const childProcess = require(' + JSON.stringify(childProcessModule) + ');',
      'const capturePath = ' + JSON.stringify(capturePath) + ';',
      'const eventsPath = ' + JSON.stringify(eventsPath) + ';',
      'const startupPath = ' + JSON.stringify(startupPath) + ';',
      'const originalUnlinkSync = fs.unlinkSync;',
      'fs.unlinkSync = (target, ...args) => {',
      '  const result = originalUnlinkSync(target, ...args);',
      "  if (String(target) === startupPath) fs.appendFileSync(eventsPath, 'startup-released\\n');",
      '  return result;',
      '};',
      'childProcess.spawnSync = (command, args, options = {}) => {',
      '  fs.writeFileSync(capturePath, JSON.stringify({ command, args, input: options.input }), \'utf8\');',
      "  fs.appendFileSync(eventsPath, 'abnormal-notification-complete\\n');",
      "  return { status: 0, stdout: '', stderr: '' };",
      '};',
    ].join('\n'), 'utf8');

    const result = spawnSync(process.execPath, [
      '-r', preloadPath,
      HOOK_SCRIPT,
      workspace,
      '',
      '3',
    ], {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...cleanSpawnEnv(),
        GH_MAESTRO_WORKER: 'issue-9-review-manager-pr-42',
        GH_MAESTRO_REVIEW_MANAGER_PR: '42',
        GH_MAESTRO_REVIEW_MANAGER_STARTUP_TOKEN: 'startup-token-42',
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const relay = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
    assert.deepEqual(relay.args, [
      path.join(__dirname, '..', '..', 'scripts', 'msg-send.js'),
      '--stdin',
      '--workspace', workspace,
      '--abnormal-exit',
    ]);
    assert.match(relay.input, /exit code 3/);
    assert.deepEqual(fs.readFileSync(eventsPath, 'utf8').trim().split(/\r?\n/), [
      'abnormal-notification-complete',
      'startup-released',
    ]);
    assert.equal(fs.existsSync(startupPath), false);
  });
});

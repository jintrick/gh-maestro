'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');
const { cleanSpawnEnv } = require('../_spawn-env');

function withTempDir(fn) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-msg-send-slow-'));
  try {
    return fn(workspace);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test('--abnormal-exit のorchestrator拒否は実CLI境界でもcode 1になる', () => {
  withTempDir((workspace) => {
    const script = path.join(__dirname, '..', '..', 'scripts', 'msg-send.js');
    const result = spawnSync(process.execPath, [
      script,
      'orchestrator', '--abnormal-exit', '--stdin', '--issue', '9', '--workspace', workspace,
    ], {
      cwd: workspace,
      encoding: 'utf8',
      input: 'body',
      env: { ...cleanSpawnEnv(), GH_MAESTRO_WORKER: 'orchestrator' },
      timeout: 15000,
    });
    assert.equal(result.status, 1, `nonzero exit expected; stderr: ${result.stderr}`);
    assert.match(result.stderr, /ワーカー通知専用/);
  });
});

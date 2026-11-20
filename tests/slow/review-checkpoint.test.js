'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runnerLeasePath } = require('../../scripts/shared/review-checkpoint');
const { writeRunningReviewManager } = require('../../scripts/shared/running-review-managers');
const processLiveness = require('../../scripts/shared/process-liveness');

test('resume CLI refuses a live previous job runner and preserves it', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-live-runner-'));
  try {
    const file = runnerLeasePath(ws, 123, process.pid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const processRef = processLiveness.captureSelf();
    const processRecord = processLiveness.writeRef({}, processRef);
    assert.ok(processRecord.resourceKey);
    assert.ok(processRecord.instanceId);
    writeRunningReviewManager(file, { processRef });
    const cli = path.resolve(__dirname, '../../scripts/start-review-manager.js');
    const result = spawnSync(process.execPath, [cli, '--resume', '123', 'o/r', ws, '1'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`PID ${process.pid}`));
    assert.ok(fs.existsSync(file));
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('resume CLI fails closed on corrupt runner lease', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-bad-runner-'));
  try {
    const file = runnerLeasePath(ws, 123, 456);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{');
    const cli = path.resolve(__dirname, '../../scripts/start-review-manager.js');
    const result = spawnSync(process.execPath, [cli, '--resume', '123', 'o/r', ws, '1'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /running/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sweepWorkspaceFiles, TEMP_MIN_AGE_MS, MAX_WORKER_LOG_BYTES } = require('../scripts/shared/workspace-housekeeping');

test('sweepWorkspaceFiles: 古いatomic tmpを掃除し、稼働中ワーカーのログを保護する', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-housekeeping-'));
  try {
    const maestro = path.join(workspace, '.gh-maestro');
    const logDir = path.join(maestro, 'worker-logs');
    const cursorDir = path.join(maestro, 'inbox-supervisor', 'cursors');
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });
    const old = new Date(Date.now() - TEMP_MIN_AGE_MS - 1000);
    const orphan = path.join(cursorDir, 'worker.json.abcd12');
    fs.writeFileSync(orphan, '{}');
    fs.utimesSync(orphan, old, old);
    const active = path.join(logDir, 'active.log');
    fs.writeFileSync(active, '{"type":"system","subtype":"thinking_tokens"}\n');
    const result = sweepWorkspaceFiles(workspace, { activeWorkerNames: new Set(['active']) });
    assert.ok(result.removed.includes(orphan));
    assert.equal(fs.readFileSync(active, 'utf8').length > 0, true);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('sweepWorkspaceFiles: 完了ログを圧縮し、残った肥大ログを世代ローテーションする', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-housekeeping-'));
  try {
    const logDir = path.join(workspace, '.gh-maestro', 'worker-logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'finished.log');
    fs.writeFileSync(logPath, 'x'.repeat(MAX_WORKER_LOG_BYTES + 1));
    const result = sweepWorkspaceFiles(workspace);
    assert.ok(result.rotated.includes(logPath));
    assert.ok(fs.existsSync(`${logPath}.1`));
    assert.ok(fs.statSync(logPath).size <= MAX_WORKER_LOG_BYTES);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

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
    const logDir = path.join(maestro, 'records', 'issue', '7', 'workers');
    const cursorDir = path.join(maestro, 'records', 'issue', '7', 'workers', 'issue-7-active');
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });
    const old = new Date(Date.now() - TEMP_MIN_AGE_MS - 1000);
    const orphan = path.join(cursorDir, 'worker.json.abcd12');
    fs.writeFileSync(orphan, '{}');
    fs.utimesSync(orphan, old, old);
    const active = path.join(logDir, 'issue-7-active', 'worker.log');
    fs.mkdirSync(path.dirname(active), { recursive: true });
    fs.writeFileSync(active, '{"type":"system","subtype":"thinking_tokens"}\n');
    const result = sweepWorkspaceFiles(workspace, { excludedWorkerNames: new Set(['issue-7-active']) });
    assert.ok(result.removed.includes(orphan));
    assert.equal(fs.readFileSync(active, 'utf8').length > 0, true);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('sweepWorkspaceFiles: 完了ログを圧縮せず、残った肥大ログを世代ローテーションする', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-housekeeping-'));
  try {
    const logDir = path.join(workspace, '.gh-maestro', 'records', 'issue', '7', 'workers', 'issue-7-finished');
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

test('sweepWorkspaceFiles: 稼働中Review Managerのworker logをローテーションから保護する', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-housekeeping-'));
  try {
    const workerName = 'issue-5-review-manager-pr-42';
    const logDir = path.join(workspace, '.gh-maestro', 'records', 'pr', '42', 'workers', workerName);
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'worker.log');
    fs.writeFileSync(logPath, 'x'.repeat(MAX_WORKER_LOG_BYTES + 1));
    const result = sweepWorkspaceFiles(workspace, { excludedReviewPrs: new Set(['42']) });
    assert.ok(!result.rotated.includes(logPath));
    assert.equal(fs.existsSync(`${logPath}.1`), false);
    assert.equal(fs.statSync(logPath).size, MAX_WORKER_LOG_BYTES + 1);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// ── Issue #248 項目8: sweepはログ圧縮を一切行わない ──────────────────────────
// PR #239 の回帰対策。圧縮は worker-exit-hook.js（ワーカー終了後の安全なタイミング）と
// 手動CLI cleanup-worker-logs.js のみが行う。sweepは稼働中ログに触れる圧縮経路を持たない。

test('sweepWorkspaceFiles: 稼働中ログ（excludedWorkerNames）は中身・mtime不変で、.compact-*.tmp が残らない', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-housekeeping-'));
  try {
    const logDir = path.join(workspace, '.gh-maestro', 'records', 'issue', '7', 'workers', 'issue-7-active');
    fs.mkdirSync(logDir, { recursive: true });
    const active = path.join(logDir, 'worker.log');
    const content = '{"type":"system","subtype":"thinking_tokens"}\nnormal line\n';
    fs.writeFileSync(active, content);
    // 過去の回帰で残りうる .compact-*.tmp 残骸も置いておく（掃除対象として）。
    const orphanTmp = path.join(logDir, 'worker.log.compact-123-999999.tmp');
    fs.writeFileSync(orphanTmp, content);
    const old = new Date(Date.now() - TEMP_MIN_AGE_MS - 1000);
    fs.utimesSync(orphanTmp, old, old);

    const beforeMtime = fs.statSync(active).mtimeMs;
    const result = sweepWorkspaceFiles(workspace, { excludedWorkerNames: new Set(['issue-7-active']) });

    // 稼働中ログの中身・mtimeは変わらない（圧縮もローテーションも行われない）。
    assert.equal(fs.readFileSync(active, 'utf8'), content);
    assert.equal(fs.statSync(active).mtimeMs, beforeMtime);
    // 圧縮されないため .compact-*.tmp が新たに残らない（残骸は掃除される）。
    assert.ok(result.compacted.length === 0);
    assert.ok(result.removed.includes(orphanTmp));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('sweepWorkspaceFiles: 保護されないログでも圧縮は行われない（thinking_tokens行が残る）', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-housekeeping-'));
  try {
    const logDir = path.join(workspace, '.gh-maestro', 'records', 'issue', '7', 'workers', 'issue-7-finished');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'worker.log');
    // thinking_tokens 進捗行を含むログ。従来の sweep はこれを圧縮していたが、
    // 項目8以降 sweep は圧縮しないため、行はそのまま残る。
    const content = '{"type":"system","subtype":"thinking_tokens"}\nkeep me\n';
    fs.writeFileSync(logPath, content);
    const result = sweepWorkspaceFiles(workspace);
    assert.ok(result.compacted.length === 0);
    assert.equal(fs.readFileSync(logPath, 'utf8'), content);
    assert.ok(fs.readdirSync(logDir).every(n => !n.includes('.compact-')));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// ── Issue #248 項目5: inbox-supervisor-autostart.log の世代ローテーション ─────

test('sweepWorkspaceFiles: 肥大した inbox-supervisor-autostart.log を世代ローテーションする', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-housekeeping-'));
  try {
    const maestro = path.join(workspace, '.gh-maestro');
    fs.mkdirSync(maestro, { recursive: true });
    const autostart = path.join(maestro, 'inbox-supervisor-autostart.log');
    fs.writeFileSync(autostart, 'y'.repeat(MAX_WORKER_LOG_BYTES + 1));
    const result = sweepWorkspaceFiles(workspace);
    assert.ok(result.rotated.includes(autostart));
    assert.ok(fs.existsSync(`${autostart}.1`));
    assert.ok(fs.statSync(autostart).size <= MAX_WORKER_LOG_BYTES);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('sweepWorkspaceFiles: 小さな inbox-supervisor-autostart.log はローテーションされない', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-housekeeping-'));
  try {
    const maestro = path.join(workspace, '.gh-maestro');
    fs.mkdirSync(maestro, { recursive: true });
    const autostart = path.join(maestro, 'inbox-supervisor-autostart.log');
    fs.writeFileSync(autostart, 'small');
    const result = sweepWorkspaceFiles(workspace);
    assert.ok(!result.rotated.includes(autostart));
    assert.ok(!fs.existsSync(`${autostart}.1`));
    assert.equal(fs.readFileSync(autostart, 'utf8'), 'small');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

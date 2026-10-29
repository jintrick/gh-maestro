'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const marker = require('../scripts/shared/migration-marker');
const {
  isProcessAlive,
  getProcessStartTime,
  verifyProcessIdentity,
} = require('../scripts/process-lifecycle');

let workspace;

// _set... 注入はモジュール内のモジュール変数を書き換えるため、テスト間で
// 実装を跨いで持ち越さないよう、afterEach で必ず実装へ戻す
// （実プロセス確認は行わない）。
afterEach(() => {
  marker._setIsProcessAlive(isProcessAlive);
  marker._setGetProcessStartTime(getProcessStartTime);
  marker._setVerifyProcessIdentity(verifyProcessIdentity);
  try { fs.rmSync(workspace, { recursive: true, force: true }); } catch {}
});

function freshWorkspace() {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-marker-'));
  fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
  return workspace;
}

test('markMigrationInProgress: 所有PIDとstartTimeをJSONで記録する', () => {
  const dir = freshWorkspace();
  marker._setGetProcessStartTime(() => '2026-08-01T00:00:00.000Z');

  marker.markMigrationInProgress(dir);

  const raw = JSON.parse(fs.readFileSync(marker.migrationInProgressPath(dir), 'utf8'));
  assert.equal(raw.pid, process.pid);
  assert.equal(raw.startTime, '2026-08-01T00:00:00.000Z');
});

test('isMigrationInProgress: マーカーが無ければ false', () => {
  const dir = freshWorkspace();
  assert.equal(marker.isMigrationInProgress(dir), false);
});

test('isMigrationInProgress: 所有プロセスが生存していれば true', () => {
  const dir = freshWorkspace();
  marker._setGetProcessStartTime(() => '2026-08-01T00:00:00.000Z');
  marker._setIsProcessAlive(() => true);
  marker._setVerifyProcessIdentity(() => ({ match: true }));
  marker.markMigrationInProgress(dir);

  assert.equal(marker.isMigrationInProgress(dir), true);
});

test('isMigrationInProgress: 所有プロセスが死んでいれば stale として false（自己回復）', () => {
  const dir = freshWorkspace();
  marker._setGetProcessStartTime(() => '2026-08-01T00:00:00.000Z');
  marker._setIsProcessAlive(() => false);
  marker.markMigrationInProgress(dir);

  assert.equal(marker.isMigrationInProgress(dir), false);
});

test('isMigrationInProgress: PIDが再利用され同一性が確認できなければ false', () => {
  const dir = freshWorkspace();
  marker._setGetProcessStartTime(() => '2026-08-01T00:00:00.000Z');
  marker._setIsProcessAlive(() => true);
  marker._setVerifyProcessIdentity(() => ({ match: false, reason: 'startTime mismatch' }));
  marker.markMigrationInProgress(dir);

  assert.equal(marker.isMigrationInProgress(dir), false);
});

test('isMigrationInProgress: startTime 未記録でも所有プロセス生存なら true（劣化縮退）', () => {
  const dir = freshWorkspace();
  marker._setGetProcessStartTime(() => null); // 起動時刻が取得できなかった
  marker._setIsProcessAlive(() => true);
  marker.markMigrationInProgress(dir);
  const raw = JSON.parse(fs.readFileSync(marker.migrationInProgressPath(dir), 'utf8'));
  assert.equal(raw.startTime, null);

  // startTime が null なので verifyProcessIdentity は呼ばれず、生存確認のみで抑止を維持する
  assert.equal(marker.isMigrationInProgress(dir), true);
});

test('isMigrationInProgress: 不正なPID（0以下・非数値）は false', () => {
  const dir = freshWorkspace();
  fs.writeFileSync(marker.migrationInProgressPath(dir), JSON.stringify({ pid: 0, startTime: '2026-08-01T00:00:00.000Z' }));
  assert.equal(marker.isMigrationInProgress(dir), false);

  fs.writeFileSync(marker.migrationInProgressPath(dir), JSON.stringify({ startTime: '2026-08-01T00:00:00.000Z' }));
  assert.equal(marker.isMigrationInProgress(dir), false);
});

test('isMigrationInProgress: 読めない・パースできないマーカーは false（fail-open）', () => {
  const dir = freshWorkspace();
  const p = marker.migrationInProgressPath(dir);
  fs.writeFileSync(p, ''); // 空ファイル（旧形式）
  assert.equal(marker.isMigrationInProgress(dir), false);

  fs.writeFileSync(p, 'not-json');
  assert.equal(marker.isMigrationInProgress(dir), false);
});

test('clearMigrationInProgress: マーカーを削除する', () => {
  const dir = freshWorkspace();
  marker._setGetProcessStartTime(() => '2026-08-01T00:00:00.000Z');
  marker._setIsProcessAlive(() => true);
  marker._setVerifyProcessIdentity(() => ({ match: true }));
  marker.markMigrationInProgress(dir);
  assert.equal(fs.existsSync(marker.migrationInProgressPath(dir)), true);

  marker.clearMigrationInProgress(dir);
  assert.equal(fs.existsSync(marker.migrationInProgressPath(dir)), false);
  assert.equal(marker.isMigrationInProgress(dir), false);
});

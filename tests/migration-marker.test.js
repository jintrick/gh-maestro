'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const marker = require('../scripts/shared/migration-marker');
const { createLiveness } = require('../scripts/shared/process-liveness');
let probe = 'alive';
let start = '2026-08-01T00:00:00.000Z';
function inject() { marker._setLiveness(createLiveness({ probePid: () => probe, readStartTime: () => start })); }

let workspace;

// _set... 注入はモジュール内のモジュール変数を書き換えるため、テスト間で
// 実装を跨いで持ち越さないよう、afterEach で必ず実装へ戻す
// （実プロセス確認は行わない）。
afterEach(() => {
  marker._setLiveness(null);
  probe = 'alive';
  start = '2026-08-01T00:00:00.000Z';
  try { fs.rmSync(workspace, { recursive: true, force: true }); } catch {}
});

function freshWorkspace() {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-marker-'));
  fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
  return workspace;
}

test('markMigrationInProgress: 所有PIDとstartTimeをJSONで記録する', () => {
  const dir = freshWorkspace();
  inject();

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
  inject();


  marker.markMigrationInProgress(dir);

  assert.equal(marker.isMigrationInProgress(dir), true);
});

test('isMigrationInProgress: 所有プロセスが死んでいれば stale として false（自己回復）', () => {
  const dir = freshWorkspace();
  inject();
  probe = 'dead';
  marker.markMigrationInProgress(dir);

  assert.equal(marker.isMigrationInProgress(dir), false);
});

test('isMigrationInProgress: PIDが再利用され同一性が確認できなければ false', () => {
  const dir = freshWorkspace();
  inject();

  marker.markMigrationInProgress(dir);
  start = '2026-08-02T00:00:00.000Z';

  assert.equal(marker.isMigrationInProgress(dir), false);
});

test('isMigrationInProgress: startTime 未記録でも所有プロセス生存なら true（劣化縮退）', () => {
  const dir = freshWorkspace();
  start = null; inject();

  marker.markMigrationInProgress(dir);
  const raw = JSON.parse(fs.readFileSync(marker.migrationInProgressPath(dir), 'utf8'));
  assert.equal(raw.startTime, null);

  // startTime が null なので verifyProcessIdentity は呼ばれず、生存確認のみで抑止を維持する
  assert.equal(marker.isMigrationInProgress(dir), true);
});

test('isMigrationInProgress: 不正なPIDは判定不能として抑止する', () => {
  const dir = freshWorkspace();
  fs.writeFileSync(marker.migrationInProgressPath(dir), JSON.stringify({ pid: 0, startTime: '2026-08-01T00:00:00.000Z' }));
  assert.equal(marker.isMigrationInProgress(dir), true);

  fs.writeFileSync(marker.migrationInProgressPath(dir), JSON.stringify({ startTime: '2026-08-01T00:00:00.000Z' }));
  assert.equal(marker.isMigrationInProgress(dir), true);
});

test('isMigrationInProgress: 破損マーカーはエラーを報告し保持する', () => {
  const dir = freshWorkspace();
  const p = marker.migrationInProgressPath(dir);
  for (const raw of ['', 'not-json', 'null']) {
    fs.writeFileSync(p, raw);
    assert.throws(() => marker.isMigrationInProgress(dir), /移行マーカー/);
    assert.equal(fs.readFileSync(p, 'utf8'), raw);
  }
});

test('clearMigrationInProgress: マーカーを削除する', () => {
  const dir = freshWorkspace();
  inject();


  marker.markMigrationInProgress(dir);
  assert.equal(fs.existsSync(marker.migrationInProgressPath(dir)), true);

  marker.clearMigrationInProgress(dir);
  assert.equal(fs.existsSync(marker.migrationInProgressPath(dir)), false);
  assert.equal(marker.isMigrationInProgress(dir), false);
});

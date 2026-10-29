'use strict';

const { installLivenessTestAdapter } = require('./helpers/process-liveness-test-double');
installLivenessTestAdapter();

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const marker = require('../scripts/shared/migration-marker');
const { createLiveness } = require('../scripts/shared/process-liveness');
let probe = 'alive';
function inject() { marker._setLiveness(createLiveness({ probeEndpoint: () => probe })); }

let workspace;

// _set... 注入はモジュール内のモジュール変数を書き換えるため、テスト間で
// 実装を跨いで持ち越さないよう、afterEach で必ず実装へ戻す
// （実プロセス確認は行わない）。
afterEach(() => {
  marker._setLiveness(null);
  probe = 'alive';
  try { fs.rmSync(workspace, { recursive: true, force: true }); } catch {}
});

function freshWorkspace() {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-marker-'));
  fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
  return workspace;
}

test('markMigrationInProgress: 所有PIDとresource identityをJSONで記録する', () => {
  const dir = freshWorkspace();
  inject();

  marker.markMigrationInProgress(dir);

  const raw = JSON.parse(fs.readFileSync(marker.migrationInProgressPath(dir), 'utf8'));
  assert.equal(raw.pid, process.pid);
  assert.equal(typeof raw.resourceKey, 'string');
  assert.equal(raw.startTime, undefined);
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

test('isMigrationInProgress: 所有resourceが死亡していれば false', () => {
  const dir = freshWorkspace();
  marker._setLiveness(createLiveness({ probeEndpoint: () => 'dead' }));
  fs.writeFileSync(marker.migrationInProgressPath(dir), JSON.stringify({
    pid: 12345, resourceKey: 'old-resource',
  }));

  assert.equal(marker.isMigrationInProgress(dir), false);
});

test('isMigrationInProgress: startTimeなしでも所有resourceが生存なら true', () => {
  const dir = freshWorkspace();
  inject();

  marker.markMigrationInProgress(dir);
  const raw = JSON.parse(fs.readFileSync(marker.migrationInProgressPath(dir), 'utf8'));
  assert.equal(typeof raw.resourceKey, 'string');
  assert.equal(raw.startTime, undefined);

  // resource が生存中なら、自動起動の抑止を維持する。
  assert.equal(marker.isMigrationInProgress(dir), true);
});

test('isMigrationInProgress: 不正なPIDは判定不能として抑止する', () => {
  const dir = freshWorkspace();
  fs.writeFileSync(marker.migrationInProgressPath(dir), JSON.stringify({ pid: 0, resourceKey: 'invalid-pid' }));
  assert.equal(marker.isMigrationInProgress(dir), true);

  fs.writeFileSync(marker.migrationInProgressPath(dir), JSON.stringify({ resourceKey: 'missing-pid' }));
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

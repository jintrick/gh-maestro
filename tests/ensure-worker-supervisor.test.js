'use strict';

const { installLivenessTestAdapter } = require('./helpers/process-liveness-test-double');
installLivenessTestAdapter();

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const { createTempDirScope } = require('../scripts/shared/temp-directory');

const mod = require('../scripts/shared/ensure-worker-supervisor');
const { ensureWorkerSupervisorRunning, AUTOSTART_COOLDOWN_MS } = mod;
const workerLease = require('../scripts/shared/worker-lease');
const migrationMarker = require('../scripts/shared/migration-marker');
const { readAutostartAttempt } = require('../scripts/shared/ensure-resident-daemon');

function fakeChild() {
  const emitter = new EventEmitter();
  emitter.unref = () => {};
  return emitter;
}

// 自動復活クールダウン（Issue #303）の試行記録ファイルを直接書き込む。
function attemptPath() {
  return path.join(workspace, '.gh-maestro', 'worker-supervisor-autostart-attempt.json');
}

function writeAttempt(lastAttemptAt) {
  fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
  fs.writeFileSync(attemptPath(), JSON.stringify({ lastAttemptAt }), 'utf8');
}

let workspace;
let tempDirScope;

beforeEach(() => {
  tempDirScope = createTempDirScope();
  workspace = tempDirScope.mkdtemp('ensure-supervisor-');
  mod._setSpawn(() => fakeChild());
  mod._setFindRunningInstance(() => null);
  // 既定は実装（worker-lease.isResidentLeaseLive）。テスト用 temp workspace には
  // orchestrator msg-poll lease が存在する状態を表し、supervisor lease は未作成にする。
  mod._setIsResidentLeaseLive(({ role }) => role === workerLease.MSGPOLL_ORCHESTRATOR_ROLE);
});

afterEach(() => {
  try {
    // マーカーの生存確認注入を実装へ戻す（テスト間で持ち越さない）
    migrationMarker._setLiveness(null);
  } finally {
    tempDirScope.cleanup();
  }
});

test('ensureWorkerSupervisorRunning: detached・windowsHide付きでworker-supervisor.jsをspawnする', () => {
  let captured = null;
  mod._setSpawn((cmd, args, opts) => {
    captured = { cmd, args, opts };
    return fakeChild();
  });

  ensureWorkerSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });

  assert.equal(captured.cmd, process.execPath);
  assert.deepEqual(captured.args, [
    path.join('/abs/scripts', 'worker-supervisor.js'),
    '--workspace', workspace,
  ]);
  assert.ok(captured.opts.env.GH_MAESTRO_RESOURCE_KEY, 'child receives a fresh OS-resource identity');
  assert.equal(captured.opts.detached, true);
  assert.equal(captured.opts.windowsHide, true);
});

test('ensureWorkerSupervisorRunning: Claude親セッションPIDを子へ渡さない', () => {
  let captured = null;
  mod._setSpawn((cmd, args, opts) => {
    captured = { cmd, args, opts };
    return fakeChild();
  });

  ensureWorkerSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });

  assert.equal(captured.args.includes('--session-pid'), false);
});

test('ensureWorkerSupervisorRunning: 既にSupervisorが稼働中ならspawnもセッションPID解決も行わない', () => {
  mod._setFindRunningInstance(() => ({ pid: 777, script: 'worker-supervisor.js' }));
  let spawnCalled = false;
  mod._setSpawn(() => { spawnCalled = true; return fakeChild(); });

  ensureWorkerSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });

  assert.equal(spawnCalled, false);
});

test('ensureWorkerSupervisorRunning: 改名前のregistry/roleを検出した場合もspawnしない', () => {
  let spawned = false;
  mod._setFindRunningInstance((_, opts) => (
    opts.script === 'inbox-supervisor.js' ? { pid: 778, script: opts.script } : null
  ));
  mod._setSpawn(() => { spawned = true; return fakeChild(); });
  mod._setIsResidentLeaseLive(() => false);

  ensureWorkerSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });
  assert.equal(spawned, false);
});

test('ensureWorkerSupervisorRunning: 所有プロセス生存中の.migration-in-progressマーカー存在時はspawnもセッションPID解決も行わない（Issue #256）', () => {
  // 有効なマーカー（所有プロセス生存）を作成する
  migrationMarker._setLiveness(require('../scripts/shared/process-liveness').createLiveness({ probePid: () => 'alive', readStartTime: () => '2026-08-01T00:00:00.000Z' }));
  migrationMarker.markMigrationInProgress(workspace);
  mod._setFindRunningInstance(() => null);
  let spawnCalled = false;
  mod._setSpawn(() => { spawnCalled = true; return fakeChild(); });

  ensureWorkerSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });

  assert.equal(spawnCalled, false);
});

test('ensureWorkerSupervisorRunning: 所有プロセスが死んだstaleマーカーは無視して自動起動する（自己回復）', () => {
  // 移行プロセスが強制終了して削除されずに残ったマーカー（所有プロセスは死んでいる）
  migrationMarker._setLiveness(require('../scripts/shared/process-liveness').createLiveness({ probePid: () => 'dead', readStartTime: () => '2026-08-01T00:00:00.000Z' }));
  migrationMarker.markMigrationInProgress(workspace);
  assert.equal(migrationMarker.isMigrationInProgress(workspace), false);
  mod._setFindRunningInstance(() => null);
  let spawnCalled = false;
  mod._setSpawn(() => { spawnCalled = true; return fakeChild(); });

  ensureWorkerSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });

  assert.equal(spawnCalled, true);
});

test('ensureWorkerSupervisorRunning: 稼働中判定が例外を投げてもfail-openでspawnを試みる', () => {
  mod._setFindRunningInstance(() => { throw new Error('registry read failed'); });
  let spawnCalled = false;
  mod._setSpawn(() => { spawnCalled = true; return fakeChild(); });

  ensureWorkerSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });

  assert.equal(spawnCalled, true);
});

test('ensureWorkerSupervisorRunning: registryに無くても role lease が live なら spawn しない（Issue #240）', () => {
  mod._setFindRunningInstance(() => null); // registry にはエントリが無い
  mod._setIsResidentLeaseLive(() => true); // 依存leaseとsupervisor leaseがlive
  let spawnCalled = false;
  mod._setSpawn(() => { spawnCalled = true; return fakeChild(); });

  ensureWorkerSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });

  assert.equal(spawnCalled, false);
});

test('ensureWorkerSupervisorRunning: 依存 role lease 判定が不明なら孤立起動しない', () => {
  mod._setFindRunningInstance(() => null);
  mod._setIsResidentLeaseLive(() => { throw new Error('lease read failed'); });
  let spawnCalled = false;
  mod._setSpawn(() => { spawnCalled = true; return fakeChild(); });

  ensureWorkerSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });

  assert.equal(spawnCalled, false);
});

test('ensureWorkerSupervisorRunning: unrefを呼ぶ（呼び出し元プロセスをブロックしない）', () => {
  let unrefCalled = false;
  mod._setSpawn(() => {
    const c = fakeChild();
    c.unref = () => { unrefCalled = true; };
    return c;
  });

  ensureWorkerSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });
  assert.equal(unrefCalled, true);
});

test('ensureWorkerSupervisorRunning: workspace未指定なら何もしない（spawnを呼ばない）', () => {
  let called = false;
  mod._setSpawn(() => { called = true; return fakeChild(); });

  ensureWorkerSupervisorRunning({ workspace: null, scriptsPath: '/abs/scripts' });
  assert.equal(called, false);
});

test('ensureWorkerSupervisorRunning: scriptsPath未指定なら何もしない（spawnを呼ばない）', () => {
  let called = false;
  mod._setSpawn(() => { called = true; return fakeChild(); });

  ensureWorkerSupervisorRunning({ workspace, scriptsPath: null });
  assert.equal(called, false);
});

test('ensureWorkerSupervisorRunning: spawnが例外を投げても呼び出し元に伝播しない（best-effort）', () => {
  mod._setSpawn(() => { throw new Error('boom'); });

  assert.doesNotThrow(() => ensureWorkerSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' }));
});

test('ensureWorkerSupervisorRunning: .gh-maestro/worker-supervisor-autostart.log を作成する', () => {
  ensureWorkerSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });
  const logPath = path.join(workspace, '.gh-maestro', 'worker-supervisor-autostart.log');
  assert.ok(fs.existsSync(logPath));
});

// ── 自動復活の有界化（Issue #303） ──────────────────────────────────────────

test('ensureWorkerSupervisorRunning: 直前の試行がクールダウン中なら再試行しない（1回/5分に有界）', () => {
  // lease 拒否・起動直後の異常終了・spawn 失敗のいずれも「次のトリガー時点では稼働中でない」
  // としか見えないため、単一のクールダウンに含まれる。
  let spawnCount = 0;
  mod._setSpawn(() => { spawnCount += 1; return fakeChild(); });

  ensureWorkerSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' }); // 1回目: spawn する
  assert.equal(spawnCount, 1);
  assert.ok(fs.existsSync(attemptPath()), '試行記録が残る');

  ensureWorkerSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' }); // クールダウン中: 再試行しない
  assert.equal(spawnCount, 1);
});

test('ensureWorkerSupervisorRunning: クールダウン期限経過後は再試行する', () => {
  writeAttempt(Date.now() - (AUTOSTART_COOLDOWN_MS + 1000)); // 期限を超えた試行
  let spawnCount = 0;
  mod._setSpawn(() => { spawnCount += 1; return fakeChild(); });

  ensureWorkerSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });
  assert.equal(spawnCount, 1);
});

test('ensureWorkerSupervisorRunning: クールダウンぎりぎり（期限内）は再試行しない', () => {
  writeAttempt(Date.now() - (AUTOSTART_COOLDOWN_MS - 1000)); // まだ期限内
  let spawnCount = 0;
  mod._setSpawn(() => { spawnCount += 1; return fakeChild(); });

  ensureWorkerSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });
  assert.equal(spawnCount, 0);
});

test('ensureWorkerSupervisorRunning: 生存（registry）を観測したら試行記録を消し、以後の試行を妨げない', () => {
  writeAttempt(Date.now()); // 新鮮な記録 = クールダウンに掛かるはず
  mod._setFindRunningInstance(() => ({ pid: 777, script: 'worker-supervisor.js' }));
  let spawnCount = 0;
  mod._setSpawn(() => { spawnCount += 1; return fakeChild(); });

  ensureWorkerSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });

  assert.equal(spawnCount, 0);
  assert.equal(fs.existsSync(attemptPath()), false, '生存観測で試行記録が消える');
});

test('ensureWorkerSupervisorRunning: 生存（role lease live）を観測したら試行記録を消し、以後の試行を妨げない', () => {
  writeAttempt(Date.now()); // 新鮮な記録 = クールダウンに掛かるはず
  mod._setFindRunningInstance(() => null);
  mod._setIsResidentLeaseLive(() => true);
  let spawnCount = 0;
  mod._setSpawn(() => { spawnCount += 1; return fakeChild(); });

  ensureWorkerSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });

  assert.equal(spawnCount, 0);
  assert.equal(fs.existsSync(attemptPath()), false, '生存観測で試行記録が消える');
});

test('ensureWorkerSupervisorRunning: 壊れた試行記録はクールダウンに掛からない（fail-open）', () => {
  fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
  fs.writeFileSync(attemptPath(), 'not-json', 'utf8');
  let spawnCount = 0;
  mod._setSpawn(() => { spawnCount += 1; return fakeChild(); });

  ensureWorkerSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });
  assert.equal(spawnCount, 1);
});

test('ensureWorkerSupervisorRunning: 未来時刻の試行記録は信頼せず再試行する', () => {
  writeAttempt(Date.now() + 60 * 1000);
  let spawnCount = 0;
  mod._setSpawn(() => { spawnCount += 1; return fakeChild(); });

  ensureWorkerSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });
  assert.equal(spawnCount, 1);
});

test('ensureWorkerSupervisorRunning: spawnが例外を投げても試行記録が残り、次のトリガーはクールダウンで抑制される', () => {
  let spawnCount = 0;
  mod._setSpawn(() => { spawnCount += 1; throw new Error('boom'); });

  ensureWorkerSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' }); // 例外は握りつぶされる
  assert.equal(spawnCount, 1);

  ensureWorkerSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' }); // クールダウン → 再試行しない
  assert.equal(spawnCount, 1);
});


test('ensureWorkerSupervisorRunning: spawn の前に試行記録が残る（再試行の抑制の前提）', () => {
  const spawned = [];

  mod._setFindRunningInstance(() => null);
  mod._setIsResidentLeaseLive(({ role }) => role === workerLease.MSGPOLL_ORCHESTRATOR_ROLE);
  mod._setSpawn(() => {
    const attempt = readAutostartAttempt(workspace, 'worker-supervisor');
    spawned.push(attempt !== null);
    return fakeChild();
  });

  ensureWorkerSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });

  assert.deepEqual(spawned, [true]);
});

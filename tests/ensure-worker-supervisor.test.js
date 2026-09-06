'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

const mod = require('../scripts/shared/ensure-worker-supervisor');
const { ensureWorkerSupervisorRunning, AUTOSTART_COOLDOWN_MS } = mod;
const workerLease = require('../scripts/shared/worker-lease');
const migrationMarker = require('../scripts/shared/migration-marker');
const {
  isProcessAlive,
  getProcessStartTime,
  verifyProcessIdentity,
} = require('../scripts/process-lifecycle');
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

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-supervisor-'));
  mod._setSpawn(() => fakeChild());
  // findSessionRootPid は実装がWMI/execSyncを呼ぶため、テストでは常にモックする
  // （実プロセスを起動しない）。
  mod._setFindSessionRootPid(() => 12345);
  mod._setFindRunningInstance(() => null);
  // 既定は実装（worker-lease.isResidentLeaseLive）。テスト用 temp workspace には
  // lease が無いため false を返し、既存テストの挙動を変えない。
  mod._setIsResidentLeaseLive(workerLease.isResidentLeaseLive);
});

afterEach(() => {
  // マーカーの生存確認注入を実装へ戻す（テスト間で持ち越さない）
  migrationMarker._setIsProcessAlive(isProcessAlive);
  migrationMarker._setGetProcessStartTime(getProcessStartTime);
  migrationMarker._setVerifyProcessIdentity(verifyProcessIdentity);
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
    '--session-pid', '12345',
  ]);
  assert.equal(captured.opts.detached, true);
  assert.equal(captured.opts.windowsHide, true);
});

test('ensureWorkerSupervisorRunning: 呼び出し元プロセスがまだ生存しているうちにセッションPIDを解決し、子へ明示的に渡す', () => {
  // 実障害の再発防止テスト: 子プロセス自身に解決を委ねると、直近の親（この
  // 呼び出し元）が既に終了した後では親チェーンを辿れず、使い捨てCLIを
  // セッション本体と誤認して数十秒で自滅していた。呼び出し元の生存中に
  // 解決した値がそのまま --session-pid として子に渡ることを確認する。
  mod._setFindSessionRootPid(() => 99999);
  let captured = null;
  mod._setSpawn((cmd, args, opts) => {
    captured = { cmd, args, opts };
    return fakeChild();
  });

  ensureWorkerSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });

  assert.ok(captured.args.includes('--session-pid'));
  assert.equal(captured.args[captured.args.indexOf('--session-pid') + 1], '99999');
});

test('ensureWorkerSupervisorRunning: セッションPID解決が失敗しても--session-pidなしでspawnする（フォールバック）', () => {
  mod._setFindSessionRootPid(() => { throw new Error('WMI failure'); });
  let captured = null;
  mod._setSpawn((cmd, args, opts) => {
    captured = { cmd, args, opts };
    return fakeChild();
  });

  ensureWorkerSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });

  assert.ok(captured, 'spawnは実行される');
  assert.equal(captured.args.includes('--session-pid'), false);
});

test('ensureWorkerSupervisorRunning: 既にSupervisorが稼働中ならspawnもセッションPID解決も行わない', () => {
  mod._setFindRunningInstance(() => ({ pid: 777, script: 'worker-supervisor.js' }));
  let spawnCalled = false;
  let resolveCalled = false;
  mod._setSpawn(() => { spawnCalled = true; return fakeChild(); });
  mod._setFindSessionRootPid(() => { resolveCalled = true; return 12345; });

  ensureWorkerSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });

  assert.equal(spawnCalled, false);
  assert.equal(resolveCalled, false);
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
  migrationMarker._setGetProcessStartTime(() => '2026-08-01T00:00:00.000Z');
  migrationMarker._setIsProcessAlive(() => true);
  migrationMarker._setVerifyProcessIdentity(() => ({ match: true }));
  migrationMarker.markMigrationInProgress(workspace);
  mod._setFindRunningInstance(() => null);
  let spawnCalled = false;
  let resolveCalled = false;
  mod._setSpawn(() => { spawnCalled = true; return fakeChild(); });
  mod._setFindSessionRootPid(() => { resolveCalled = true; return 12345; });

  ensureWorkerSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });

  assert.equal(spawnCalled, false);
  assert.equal(resolveCalled, false);
});

test('ensureWorkerSupervisorRunning: 所有プロセスが死んだstaleマーカーは無視して自動起動する（自己回復）', () => {
  // 移行プロセスが強制終了して削除されずに残ったマーカー（所有プロセスは死んでいる）
  migrationMarker._setGetProcessStartTime(() => '2026-08-01T00:00:00.000Z');
  migrationMarker._setIsProcessAlive(() => false);
  migrationMarker.markMigrationInProgress(workspace);
  assert.equal(migrationMarker.isMigrationInProgress(workspace), false);
  mod._setFindRunningInstance(() => null);
  let spawnCalled = false;
  let resolveCalled = false;
  mod._setSpawn(() => { spawnCalled = true; return fakeChild(); });
  mod._setFindSessionRootPid(() => { resolveCalled = true; return 12345; });

  ensureWorkerSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });

  assert.equal(spawnCalled, true);
  assert.equal(resolveCalled, true);
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
  mod._setIsResidentLeaseLive(() => true); // しかし role lease は live（排他の正本）
  let spawnCalled = false;
  let resolveCalled = false;
  mod._setSpawn(() => { spawnCalled = true; return fakeChild(); });
  mod._setFindSessionRootPid(() => { resolveCalled = true; return 12345; });

  ensureWorkerSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });

  assert.equal(spawnCalled, false);
  assert.equal(resolveCalled, false);
});

test('ensureWorkerSupervisorRunning: role lease 判定が例外を投げても fail-open で spawn を試みる', () => {
  mod._setFindRunningInstance(() => null);
  mod._setIsResidentLeaseLive(() => { throw new Error('lease read failed'); });
  let spawnCalled = false;
  mod._setSpawn(() => { spawnCalled = true; return fakeChild(); });

  ensureWorkerSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });

  assert.equal(spawnCalled, true);
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

test('ensureWorkerSupervisorRunning: 生存判定とクールダウン判定の順序検証（クールダウン中であっても生存観測時は試行記録が消去される）', () => {
  writeAttempt(Date.now()); // クールダウン中
  mod._setFindRunningInstance(() => ({ pid: 777, script: 'worker-supervisor.js' }));

  ensureWorkerSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });
  assert.equal(fs.existsSync(attemptPath()), false, 'クールダウン中でも生存観測で試行記録が消去される');
});

test('ensureWorkerSupervisorRunning: 呼び出しシーケンス（順序）の厳密検証', () => {
  const events = [];

  mod._setFindRunningInstance(() => {
    events.push('runningCheck');
    return null;
  });

  mod._setIsResidentLeaseLive(() => {
    events.push('leaseCheck');
    return false;
  });

  mod._setFindSessionRootPid(() => {
    events.push('resolvePid');
    return 7777;
  });

  mod._setSpawn((cmd, args, opts) => {
    const attempt = readAutostartAttempt(workspace, 'worker-supervisor');
    events.push(`spawn(recorded:${attempt !== null})`);
    return fakeChild();
  });

  ensureWorkerSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });

  assert.deepEqual(events, [
    'runningCheck',
    'runningCheck',
    'leaseCheck',
    'leaseCheck',
    'resolvePid',
    'spawn(recorded:true)',
  ]);
});

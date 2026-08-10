'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

const mod = require('../scripts/shared/ensure-inbox-supervisor');
const { ensureInboxSupervisorRunning } = mod;
const workerLease = require('../scripts/shared/worker-lease');

function fakeChild() {
  const emitter = new EventEmitter();
  emitter.unref = () => {};
  return emitter;
}

let workspace;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-supervisor-'));
  mod._setSpawn(() => fakeChild());
  // findSessionRootPid は実装がWMI/execSyncを呼ぶため、テストでは常にモックする
  // （.claude/rules/test-process-spawn-safety.md 準拠。実プロセスを起動しない）。
  mod._setFindSessionRootPid(() => 12345);
  mod._setFindRunningInstance(() => null);
  // 既定は実装（worker-lease.isResidentLeaseLive）。テスト用 temp workspace には
  // lease が無いため false を返し、既存テストの挙動を変えない。
  mod._setIsResidentLeaseLive(workerLease.isResidentLeaseLive);
});

test('ensureInboxSupervisorRunning: detached・windowsHide付きでinbox-supervisor.jsをspawnする', () => {
  let captured = null;
  mod._setSpawn((cmd, args, opts) => {
    captured = { cmd, args, opts };
    return fakeChild();
  });

  ensureInboxSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });

  assert.equal(captured.cmd, process.execPath);
  assert.deepEqual(captured.args, [
    path.join('/abs/scripts', 'inbox-supervisor.js'),
    '--workspace', workspace,
    '--session-pid', '12345',
  ]);
  assert.equal(captured.opts.detached, true);
  assert.equal(captured.opts.windowsHide, true);
});

test('ensureInboxSupervisorRunning: 呼び出し元プロセスがまだ生存しているうちにセッションPIDを解決し、子へ明示的に渡す', () => {
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

  ensureInboxSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });

  assert.ok(captured.args.includes('--session-pid'));
  assert.equal(captured.args[captured.args.indexOf('--session-pid') + 1], '99999');
});

test('ensureInboxSupervisorRunning: セッションPID解決が失敗しても--session-pidなしでspawnする（フォールバック）', () => {
  mod._setFindSessionRootPid(() => { throw new Error('WMI failure'); });
  let captured = null;
  mod._setSpawn((cmd, args, opts) => {
    captured = { cmd, args, opts };
    return fakeChild();
  });

  ensureInboxSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });

  assert.ok(captured, 'spawnは実行される');
  assert.equal(captured.args.includes('--session-pid'), false);
});

test('ensureInboxSupervisorRunning: 既にSupervisorが稼働中ならspawnもセッションPID解決も行わない', () => {
  mod._setFindRunningInstance(() => ({ pid: 777, script: 'inbox-supervisor.js' }));
  let spawnCalled = false;
  let resolveCalled = false;
  mod._setSpawn(() => { spawnCalled = true; return fakeChild(); });
  mod._setFindSessionRootPid(() => { resolveCalled = true; return 12345; });

  ensureInboxSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });

  assert.equal(spawnCalled, false);
  assert.equal(resolveCalled, false);
});

test('ensureInboxSupervisorRunning: .migration-in-progressマーカー存在中はspawnもセッションPID解決も行わない（Issue #256）', () => {
  const gh = path.join(workspace, '.gh-maestro');
  fs.mkdirSync(gh, { recursive: true });
  fs.writeFileSync(path.join(gh, '.migration-in-progress'), '');
  mod._setFindRunningInstance(() => null);
  let spawnCalled = false;
  let resolveCalled = false;
  mod._setSpawn(() => { spawnCalled = true; return fakeChild(); });
  mod._setFindSessionRootPid(() => { resolveCalled = true; return 12345; });

  ensureInboxSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });

  assert.equal(spawnCalled, false);
  assert.equal(resolveCalled, false);
});

test('ensureInboxSupervisorRunning: 稼働中判定が例外を投げてもfail-openでspawnを試みる', () => {
  mod._setFindRunningInstance(() => { throw new Error('registry read failed'); });
  let spawnCalled = false;
  mod._setSpawn(() => { spawnCalled = true; return fakeChild(); });

  ensureInboxSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });

  assert.equal(spawnCalled, true);
});

test('ensureInboxSupervisorRunning: registryに無くても role lease が live なら spawn しない（Issue #240）', () => {
  mod._setFindRunningInstance(() => null); // registry にはエントリが無い
  mod._setIsResidentLeaseLive(() => true); // しかし role lease は live（排他の正本）
  let spawnCalled = false;
  let resolveCalled = false;
  mod._setSpawn(() => { spawnCalled = true; return fakeChild(); });
  mod._setFindSessionRootPid(() => { resolveCalled = true; return 12345; });

  ensureInboxSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });

  assert.equal(spawnCalled, false);
  assert.equal(resolveCalled, false);
});

test('ensureInboxSupervisorRunning: role lease 判定が例外を投げても fail-open で spawn を試みる', () => {
  mod._setFindRunningInstance(() => null);
  mod._setIsResidentLeaseLive(() => { throw new Error('lease read failed'); });
  let spawnCalled = false;
  mod._setSpawn(() => { spawnCalled = true; return fakeChild(); });

  ensureInboxSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });

  assert.equal(spawnCalled, true);
});

test('ensureInboxSupervisorRunning: unrefを呼ぶ（呼び出し元プロセスをブロックしない）', () => {
  let unrefCalled = false;
  mod._setSpawn(() => {
    const c = fakeChild();
    c.unref = () => { unrefCalled = true; };
    return c;
  });

  ensureInboxSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });
  assert.equal(unrefCalled, true);
});

test('ensureInboxSupervisorRunning: workspace未指定なら何もしない（spawnを呼ばない）', () => {
  let called = false;
  mod._setSpawn(() => { called = true; return fakeChild(); });

  ensureInboxSupervisorRunning({ workspace: null, scriptsPath: '/abs/scripts' });
  assert.equal(called, false);
});

test('ensureInboxSupervisorRunning: scriptsPath未指定なら何もしない（spawnを呼ばない）', () => {
  let called = false;
  mod._setSpawn(() => { called = true; return fakeChild(); });

  ensureInboxSupervisorRunning({ workspace, scriptsPath: null });
  assert.equal(called, false);
});

test('ensureInboxSupervisorRunning: spawnが例外を投げても呼び出し元に伝播しない（best-effort）', () => {
  mod._setSpawn(() => { throw new Error('boom'); });

  assert.doesNotThrow(() => ensureInboxSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' }));
});

test('ensureInboxSupervisorRunning: .gh-maestro/inbox-supervisor-autostart.log を作成する', () => {
  ensureInboxSupervisorRunning({ workspace, scriptsPath: '/abs/scripts' });
  const logPath = path.join(workspace, '.gh-maestro', 'inbox-supervisor-autostart.log');
  assert.ok(fs.existsSync(logPath));
});

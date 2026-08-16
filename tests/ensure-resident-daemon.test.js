'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

const {
  ensureResidentDaemon,
  createDaemonHooks,
  AUTOSTART_COOLDOWN_MS,
  autostartAttemptPath,
  readAutostartAttempt,
  recordAutostartAttempt,
  clearAutostartAttempt,
} = require('../scripts/shared/ensure-resident-daemon');
const migrationMarker = require('../scripts/shared/migration-marker');
const {
  isProcessAlive,
  getProcessStartTime,
  verifyProcessIdentity,
} = require('../scripts/process-lifecycle');

function fakeChild() {
  const emitter = new EventEmitter();
  emitter.unref = () => {};
  return emitter;
}

let workspace;
let hooks;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-daemon-'));
  hooks = createDaemonHooks();
  hooks.setSpawn(() => fakeChild());
  hooks.setFindSessionRootPid(() => 12345);
  hooks.setFindRunningInstance(() => null);
  hooks.setIsResidentLeaseLive(() => false);
});

afterEach(() => {
  migrationMarker._setIsProcessAlive(isProcessAlive);
  migrationMarker._setGetProcessStartTime(getProcessStartTime);
  migrationMarker._setVerifyProcessIdentity(verifyProcessIdentity);
});

test('ensureResidentDaemon: 基本動作 - detached・windowsHide付きでスクリプトをspawnする', () => {
  let captured = null;
  hooks.setSpawn((cmd, args, opts) => {
    captured = { cmd, args, opts };
    return fakeChild();
  });

  ensureResidentDaemon({
    workspace,
    scriptsPath: '/abs/scripts',
    scriptName: 'test-daemon.js',
    logFileName: 'test-daemon-autostart.log',
    attemptName: 'test-daemon',
    hooks,
  });

  assert.equal(captured.cmd, process.execPath);
  assert.deepEqual(captured.args, [
    path.join('/abs/scripts', 'test-daemon.js'),
    '--workspace', workspace,
    '--session-pid', '12345',
  ]);
  assert.equal(captured.opts.detached, true);
  assert.equal(captured.opts.windowsHide, true);
  assert.ok(fs.existsSync(path.join(workspace, '.gh-maestro', 'test-daemon-autostart.log')));
});

test('ensureResidentDaemon: buildArgs カスタマイズで引数を構築できる', () => {
  let captured = null;
  hooks.setSpawn((cmd, args, opts) => {
    captured = { cmd, args, opts };
    return fakeChild();
  });

  ensureResidentDaemon({
    workspace,
    scriptsPath: '/abs/scripts',
    scriptName: 'custom-daemon.js',
    logFileName: 'custom.log',
    attemptName: 'custom',
    buildArgs: ({ workspace: ws, sessionPid }) => ['orchestrator', '--ws', ws, '--pid', String(sessionPid)],
    hooks,
  });

  assert.deepEqual(captured.args, [
    path.join('/abs/scripts', 'custom-daemon.js'),
    'orchestrator',
    '--ws', workspace,
    '--pid', '12345',
  ]);
});

test('ensureResidentDaemon: 引数欠落バリデーション（必須パラメータが無い場合はspawnしない）', () => {
  let spawnCalled = false;
  hooks.setSpawn(() => { spawnCalled = true; return fakeChild(); });

  ensureResidentDaemon({ workspace: null, scriptsPath: '/a', scriptName: 'b', logFileName: 'c', attemptName: 'd', hooks });
  ensureResidentDaemon({ workspace, scriptsPath: null, scriptName: 'b', logFileName: 'c', attemptName: 'd', hooks });
  ensureResidentDaemon({ workspace, scriptsPath: '/a', scriptName: null, logFileName: 'c', attemptName: 'd', hooks });
  ensureResidentDaemon({ workspace, scriptsPath: '/a', scriptName: 'b', logFileName: null, attemptName: 'd', hooks });
  ensureResidentDaemon({ workspace, scriptsPath: '/a', scriptName: 'b', logFileName: 'c', attemptName: null, hooks });

  assert.equal(spawnCalled, false);
});

test('ensureResidentDaemon: 有効な .migration-in-progress マーカー存在時は起動を見送る', () => {
  migrationMarker._setGetProcessStartTime(() => '2026-08-01T00:00:00.000Z');
  migrationMarker._setIsProcessAlive(() => true);
  migrationMarker._setVerifyProcessIdentity(() => ({ match: true }));
  migrationMarker.markMigrationInProgress(workspace);

  let spawnCalled = false;
  hooks.setSpawn(() => { spawnCalled = true; return fakeChild(); });

  ensureResidentDaemon({
    workspace,
    scriptsPath: '/abs/scripts',
    scriptName: 'test-daemon.js',
    logFileName: 'test.log',
    attemptName: 'test',
    hooks,
  });

  assert.equal(spawnCalled, false);
});

test('ensureResidentDaemon: 稼働中判定またはrole lease live時は起動をスキップする', () => {
  let spawnCalled = false;
  hooks.setSpawn(() => { spawnCalled = true; return fakeChild(); });

  // 1. running instance あり
  hooks.setFindRunningInstance(() => ({ pid: 888 }));
  ensureResidentDaemon({
    workspace,
    scriptsPath: '/abs/scripts',
    scriptName: 'test-daemon.js',
    logFileName: 'test.log',
    attemptName: 'test',
    hooks,
  });
  assert.equal(spawnCalled, false);

  // 2. lease live あり
  hooks.setFindRunningInstance(() => null);
  hooks.setIsResidentLeaseLive(() => true);
  ensureResidentDaemon({
    workspace,
    scriptsPath: '/abs/scripts',
    scriptName: 'test-daemon.js',
    role: 'some-role',
    logFileName: 'test.log',
    attemptName: 'test',
    hooks,
  });
  assert.equal(spawnCalled, false);
});

test('ensureResidentDaemon: 判定失敗時はfail-openでspawnを試みる', () => {
  hooks.setFindRunningInstance(() => { throw new Error('registry error'); });
  hooks.setIsResidentLeaseLive(() => { throw new Error('lease error'); });

  let spawnCalled = false;
  hooks.setSpawn(() => { spawnCalled = true; return fakeChild(); });

  ensureResidentDaemon({
    workspace,
    scriptsPath: '/abs/scripts',
    scriptName: 'test-daemon.js',
    role: 'some-role',
    logFileName: 'test.log',
    attemptName: 'test',
    hooks,
  });

  assert.equal(spawnCalled, true);
});

test('ensureResidentDaemon: 試行記録ファイルのパスが規則 .gh-maestro/<attemptName>-autostart-attempt.json と完全一致する', () => {
  const p1 = autostartAttemptPath(workspace, 'inbox-supervisor');
  const p2 = autostartAttemptPath(workspace, 'msg-poll');
  assert.equal(p1, path.join(workspace, '.gh-maestro', 'inbox-supervisor-autostart-attempt.json'));
  assert.equal(p2, path.join(workspace, '.gh-maestro', 'msg-poll-autostart-attempt.json'));
});

test('ensureResidentDaemon: クールダウン制御 - 連続呼び出し時にspawnが抑制され、期限経過後に再開する', () => {
  let spawnCount = 0;
  hooks.setSpawn(() => { spawnCount += 1; return fakeChild(); });

  const attemptFile = autostartAttemptPath(workspace, 'daemon-a');

  // 1回目: spawn され試行記録が残る
  ensureResidentDaemon({
    workspace,
    scriptsPath: '/abs/scripts',
    scriptName: 'daemon-a.js',
    logFileName: 'a.log',
    attemptName: 'daemon-a',
    hooks,
  });
  assert.equal(spawnCount, 1);
  assert.ok(fs.existsSync(attemptFile));

  // 2回目（直後）: クールダウン中で spawn されない
  ensureResidentDaemon({
    workspace,
    scriptsPath: '/abs/scripts',
    scriptName: 'daemon-a.js',
    logFileName: 'a.log',
    attemptName: 'daemon-a',
    hooks,
  });
  assert.equal(spawnCount, 1);

  // 試行記録を期限切れに書き換える
  fs.writeFileSync(attemptFile, JSON.stringify({ lastAttemptAt: Date.now() - (AUTOSTART_COOLDOWN_MS + 1000) }), 'utf8');

  // 3回目（期限切れ後）: spawn される
  ensureResidentDaemon({
    workspace,
    scriptsPath: '/abs/scripts',
    scriptName: 'daemon-a.js',
    logFileName: 'a.log',
    attemptName: 'daemon-a',
    hooks,
  });
  assert.equal(spawnCount, 2);
});

test('ensureResidentDaemon: 生存観測時（running / lease live）に試行記録が削除される', () => {
  const attemptFile = autostartAttemptPath(workspace, 'daemon-b');
  fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
  fs.writeFileSync(attemptFile, JSON.stringify({ lastAttemptAt: Date.now() }), 'utf8');
  assert.ok(fs.existsSync(attemptFile));

  hooks.setFindRunningInstance(() => ({ pid: 999 }));

  ensureResidentDaemon({
    workspace,
    scriptsPath: '/abs/scripts',
    scriptName: 'daemon-b.js',
    logFileName: 'b.log',
    attemptName: 'daemon-b',
    hooks,
  });

  assert.equal(fs.existsSync(attemptFile), false, '稼働中インスタンス観測で記録削除');

  // lease live でも同様に削除される
  fs.writeFileSync(attemptFile, JSON.stringify({ lastAttemptAt: Date.now() }), 'utf8');
  hooks.setFindRunningInstance(() => null);
  hooks.setIsResidentLeaseLive(() => true);

  ensureResidentDaemon({
    workspace,
    scriptsPath: '/abs/scripts',
    scriptName: 'daemon-b.js',
    role: 'role-b',
    logFileName: 'b.log',
    attemptName: 'daemon-b',
    hooks,
  });

  assert.equal(fs.existsSync(attemptFile), false, 'role lease live 観測で記録削除');
});

test('ensureResidentDaemon: 破損記録・未来時刻記録は fail-open で再試行を妨げない', () => {
  const attemptFile = autostartAttemptPath(workspace, 'daemon-c');
  fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });

  let spawnCount = 0;
  hooks.setSpawn(() => { spawnCount += 1; return fakeChild(); });

  // 壊れたJSON
  fs.writeFileSync(attemptFile, '{ broken json', 'utf8');
  ensureResidentDaemon({
    workspace,
    scriptsPath: '/abs/scripts',
    scriptName: 'daemon-c.js',
    logFileName: 'c.log',
    attemptName: 'daemon-c',
    hooks,
  });
  assert.equal(spawnCount, 1);

  // 未来時刻
  fs.writeFileSync(attemptFile, JSON.stringify({ lastAttemptAt: Date.now() + 60000 }), 'utf8');
  ensureResidentDaemon({
    workspace,
    scriptsPath: '/abs/scripts',
    scriptName: 'daemon-c.js',
    logFileName: 'c.log',
    attemptName: 'daemon-c',
    hooks,
  });
  assert.equal(spawnCount, 2);
});

test('ensureResidentDaemon: spawn例外時も試行記録が残り、次のトリガーは抑制される', () => {
  let spawnCount = 0;
  hooks.setSpawn(() => { spawnCount += 1; throw new Error('spawn failed'); });

  // 1回目: 例外を握りつぶし、記録を残す
  assert.doesNotThrow(() => {
    ensureResidentDaemon({
      workspace,
      scriptsPath: '/abs/scripts',
      scriptName: 'daemon-d.js',
      logFileName: 'd.log',
      attemptName: 'daemon-d',
      hooks,
    });
  });
  assert.equal(spawnCount, 1);

  // 2回目: クールダウンで抑制
  ensureResidentDaemon({
    workspace,
    scriptsPath: '/abs/scripts',
    scriptName: 'daemon-d.js',
    logFileName: 'd.log',
    attemptName: 'daemon-d',
    hooks,
  });
  assert.equal(spawnCount, 1);
});

test('ensureResidentDaemon: 生存判定とクールダウン判定の順序検証（クールダウン中であっても生存観測時はclearAutostartAttemptされる）', () => {
  // クールダウン判定を生前判定より前に置いてしまうと、クールダウン中に生存プロセスが立ち上がっても
  // 試行記録が削除されずに早期 return してしまう。この順序不整合を検出する。
  const attemptFile = autostartAttemptPath(workspace, 'daemon-order');
  fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
  fs.writeFileSync(attemptFile, JSON.stringify({ lastAttemptAt: Date.now() }), 'utf8');

  // 生存中
  hooks.setFindRunningInstance(() => ({ pid: 1001 }));

  ensureResidentDaemon({
    workspace,
    scriptsPath: '/abs/scripts',
    scriptName: 'daemon-order.js',
    logFileName: 'order.log',
    attemptName: 'daemon-order',
    hooks,
  });

  assert.equal(fs.existsSync(attemptFile), false, 'クールダウン中でも生存観測で確実に試行記録が消去される');
});

test('ensureResidentDaemon: 呼び出しシーケンス（順序）の厳密検証', () => {
  // 順序: migrationCheck -> runningCheck -> leaseCheck -> cooldownCheck -> resolvePid -> recordAttempt -> spawn
  const events = [];

  hooks.setIsMigrationInProgress((ws) => {
    events.push('migrationCheck');
    return false;
  });

  hooks.setFindRunningInstance((ws, opts) => {
    events.push('runningCheck');
    return null;
  });

  hooks.setIsResidentLeaseLive((opts) => {
    events.push('leaseCheck');
    return false;
  });

  hooks.setFindSessionRootPid(() => {
    events.push('resolvePid');
    return 9999;
  });

  hooks.setSpawn((cmd, args, opts) => {
    // spawn 時点ですでに試行記録がファイルに書かれていることを確認
    const attempt = readAutostartAttempt(workspace, 'daemon-seq');
    events.push(`spawn(recorded:${attempt !== null})`);
    return fakeChild();
  });

  ensureResidentDaemon({
    workspace,
    scriptsPath: '/abs/scripts',
    scriptName: 'daemon-seq.js',
    role: 'seq-role',
    logFileName: 'seq.log',
    attemptName: 'daemon-seq',
    hooks,
  });

  assert.deepEqual(events, [
    'migrationCheck',
    'runningCheck',
    'leaseCheck',
    'resolvePid',
    'spawn(recorded:true)',
  ]);
});

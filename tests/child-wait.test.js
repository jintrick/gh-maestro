'use strict';
// tests/child-wait.test.js
//
// 共有 waitChildExit（scripts/shared/child-wait.js）の単体テスト。
// 実プロセスを spawn しない。
// killProcessTree の観測は child-process.js の spawnSync（Windows: taskkill）と
// process.kill（Unix: プロセスグループ）をモックして行う。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const childWaitPath = require.resolve('../scripts/shared/child-wait');
const childProcessPath = require.resolve('../scripts/shared/child-process');
const killTreePath = require.resolve('../scripts/shared/kill-tree');

/** spawn 済み ChildProcess のフェイク（stdout + pid + kill を持つ EventEmitter）。 */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = () => {};
  child.pid = 9999;
  return child;
}

/**
 * child-process.js の spawnSync をモックした状態で child-wait.js を再ロードする。
 * kill-tree.js が spawnSync をロード時点で捕捉するため、キャッシュを必ず消す。
 * @returns {{ waitChildExit: Function, taskkillCalls: Array<Array<string>> }}
 */
function loadChildWait() {
  const taskkillCalls = [];
  delete require.cache[childWaitPath];
  delete require.cache[killTreePath];
  delete require.cache[childProcessPath];
  require.cache[childProcessPath] = {
    id: childProcessPath,
    filename: childProcessPath,
    loaded: true,
    exports: {
      spawn: () => { throw new Error('spawn should not be called in child-wait tests'); },
      spawnSync: (cmd, args) => {
        if (cmd === 'taskkill') taskkillCalls.push(args);
        return { status: 0, stdout: '', stderr: '' };
      },
      execSync: () => '',
    },
  };
  const mod = require(childWaitPath);
  delete require.cache[childProcessPath];
  delete require.cache[killTreePath];
  return { waitChildExit: mod.waitChildExit, taskkillCalls };
}

test('waitChildExit: close で終了コードを resolve し、onCleanup を実行する', async () => {
  const { waitChildExit } = loadChildWait();
  const child = fakeChild();
  let cleanupCount = 0;
  const pending = waitChildExit({ child, timeoutMs: 1000, onCleanup: () => { cleanupCount++; } });
  child.emit('close', 0);
  assert.equal(await pending, 0);
  assert.equal(cleanupCount, 1);
});

test('waitChildExit: error で reject し、onCleanup を実行する', async () => {
  const { waitChildExit } = loadChildWait();
  const child = fakeChild();
  let cleanupCount = 0;
  const pending = waitChildExit({ child, timeoutMs: 1000, onCleanup: () => { cleanupCount++; } });
  child.emit('error', new Error('boom'));
  await assert.rejects(pending, /boom/);
  assert.equal(cleanupCount, 1);
});

test('waitChildExit: タイムアウトで killProcessTree でプロセスツリーを終了し、close で解決する', async () => {
  const { waitChildExit, taskkillCalls } = loadChildWait();
  const child = fakeChild();
  child.pid = 4242;
  const origKill = process.kill;
  let processKillCalled = false;
  process.kill = () => { processKillCalled = true; return true; };
  try {
    const pending = waitChildExit({ child, timeoutMs: 5, onCleanup: () => {} });
    // タイマー発火を待つ（実closeを待つとタイマーはクリアされるため、先に発火を確認）
    await new Promise((r) => setTimeout(r, 50));
    if (process.platform === 'win32') {
      assert.ok(taskkillCalls.some((args) => args.includes('/T') && args.includes(String(child.pid))));
    } else {
      assert.equal(processKillCalled, true);
    }
    // タイマーでkillされた後、子プロセスの終了（close）で解決する
    child.emit('close', 137);
    assert.equal(await pending, 137);
  } finally {
    process.kill = origKill;
  }
});

test('waitChildExit: error と close の両方が発火しても onCleanup は1回だけ（settled ガード）', async () => {
  const { waitChildExit } = loadChildWait();
  const child = fakeChild();
  let cleanupCount = 0;
  const pending = waitChildExit({ child, timeoutMs: 1000, onCleanup: () => { cleanupCount++; } });
  child.emit('error', new Error('boom'));
  child.emit('close', 1); // error 後の close。settled 済みのため無視される
  await assert.rejects(pending, /boom/);
  assert.equal(cleanupCount, 1);
});

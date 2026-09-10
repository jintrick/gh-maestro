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
function loadChildWait(rootPid = 9999) {
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
        if (cmd === 'ps') return { status: 0, stdout: `${rootPid} 1 ${rootPid}\n`, stderr: '' };
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

test('waitChildExit: kill後にcloseが届かなくてもkill猶予後にrejectして完了する', async () => {
  const { waitChildExit } = loadChildWait();
  const child = fakeChild();
  let cleanupCount = 0;
  const pending = waitChildExit({ child, timeoutMs: 1, killGraceMs: 5, onCleanup: () => { cleanupCount++; } });
  await assert.rejects(pending, /did not exit after timeout/);
  assert.equal(cleanupCount, 1);
});

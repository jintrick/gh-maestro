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

const childWaitPath = require.resolve('../../scripts/shared/child-wait');
const childProcessPath = require.resolve('../../scripts/shared/child-process');
const killTreePath = require.resolve('../../scripts/shared/kill-tree');

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



test('waitChildExit: タイムアウトで killProcessTree でプロセスツリーを終了し、close で解決する', async () => {
  const { waitChildExit, taskkillCalls } = loadChildWait(4242);
  const child = fakeChild();
  child.pid = 4242;
  const origKill = process.kill;
  let processKillCalled = false;
  process.kill = (pid, signal) => {
    if (signal === 0) {
      const error = new Error('process is not alive');
      error.code = 'ESRCH';
      throw error;
    }
    processKillCalled = true;
    return true;
  };
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

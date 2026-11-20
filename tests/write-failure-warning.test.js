'use strict';
// tests/write-failure-warning.test.js
//
// 書き込み連続失敗の警告モニター（scripts/shared/write-failure-warning.js）の単体テスト。
// 実プロセスを spawn しない。

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createWriteFailureMonitor, DEFAULT_WRITE_FAILURE_THRESHOLD } = require('../scripts/shared/write-failure-warning');

test('既定閾値は5（ポーリング間隔20秒で約100秒相当）', () => {
  assert.equal(DEFAULT_WRITE_FAILURE_THRESHOLD, 5);
});

test('連続失敗が閾値に達したら notify が1回だけ呼ばれる', () => {
  const notified = [];
  const m = createWriteFailureMonitor({ threshold: 3, notify: (ctx) => notified.push(ctx) });
  m.onFailure('a');
  m.onFailure('b');
  m.onFailure('c');
  assert.equal(notified.length, 1);
  assert.deepEqual(notified[0], { count: 3, detail: 'c' });
});

test('成功するとカウンタがリセットされる', () => {
  const notified = [];
  const m = createWriteFailureMonitor({ threshold: 3, notify: (ctx) => notified.push(ctx) });
  m.onFailure('a');   // 1
  m.onSuccess();      // a を破棄して 0 に戻す
  m.onFailure('b');   // 1
  m.onFailure('c');   // 2 → 閾値(3)未満のため notify なし
  // リセットが効いていなければ a,b,c の3連続で通知されていたはず
  assert.equal(notified.length, 0);
  m.onFailure('d');   // 3 → notify
  assert.equal(notified.length, 1);
  assert.deepEqual(notified[0], { count: 3, detail: 'd' });
});

test('通知後はカウンタが0に戻り、再び閾値分の連続失敗が積もるまで再通知しない', () => {
  const notified = [];
  const m = createWriteFailureMonitor({ threshold: 3, notify: (ctx) => notified.push(ctx) });
  m.onFailure(); m.onFailure(); m.onFailure();
  assert.equal(notified.length, 1);
  m.onFailure(); m.onFailure();
  assert.equal(notified.length, 1);
  m.onFailure();
  assert.equal(notified.length, 2);
});

test('current() で現在の連続失敗数が読める', () => {
  const m = createWriteFailureMonitor({ threshold: 5, notify: () => {} });
  assert.equal(m.current(), 0);
  m.onFailure('a');
  m.onFailure('b');
  assert.equal(m.current(), 2);
  m.onSuccess();
  assert.equal(m.current(), 0);
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLiveness } = require('../scripts/shared/process-liveness');

const time = '2025-01-01T00:00:00.000Z';
test('opaque reference observes live, reused and missing processes', () => {
  let probe = 'alive';
  let start = time;
  const liveness = createLiveness({ probePid: () => probe, readStartTime: () => start });
  const ref = liveness.captureProcess(123);
  assert.equal(typeof ref, 'string');
  assert.equal(liveness.observe(ref), 'alive');
  start = '2025-01-01T00:00:05.000Z';
  assert.equal(liveness.observe(ref), 'dead');
  probe = 'dead';
  assert.equal(liveness.observe(ref), 'dead');
});
test('missing identity and failed probes remain unknown', () => {
  let probe = 'alive';
  let start = time;
  const liveness = createLiveness({ probePid: () => probe, readStartTime: () => start });
  assert.equal(liveness.observe(liveness.readRef({ pid: 123 })), 'unknown');
  probe = 'dead';
  assert.equal(liveness.observe(liveness.readRef({ pid: 123 })), 'unknown');
  probe = 'alive';
  const ref = liveness.captureProcess(123);
  probe = 'unknown';
  assert.equal(liveness.observe(ref), 'unknown');
  probe = 'alive'; start = null;
  assert.equal(liveness.observe(ref), 'unknown');
  start = 'invalid';
  assert.equal(liveness.observe(ref), 'unknown');
  assert.equal(liveness.observe('invalid'), 'unknown');
});
test('reference serialization and comparison are owned by liveness', () => {
  const liveness = createLiveness({ readStartTime: () => time });
  const ref = liveness.captureProcess(123);
  const record = liveness.writeRef({ purpose: 'worker' }, ref);
  assert.deepEqual(record, { purpose: 'worker', pid: 123, startTime: time });
  assert.equal(liveness.sameRef(ref, liveness.readRef(record)), true);
  assert.equal(liveness.sameRef(ref, liveness.readRef({ pid: 124, startTime: time })), false);
  assert.throws(() => liveness.writeRef({}, 'invalid'));
});

test('watchParent: 一時的な消滅は猶予し3回連続で死亡とする', () => {
  let current = 'alive';
  const api = createLiveness({ probePid: () => current, readStartTime: () => time });
  const watch = api.watchParent(api.captureProcess(123));
  current = 'dead';
  assert.equal(watch(), true);
  assert.equal(watch(), true);
  assert.equal(watch(), false);
});
test('watchParent: PID 再利用は即時に死亡とし照会失敗では終了しない', () => {
  let actual = time;
  const api = createLiveness({ probePid: () => 'alive', readStartTime: () => actual });
  const watch = api.watchParent(api.captureProcess(123));
  actual = null;
  assert.equal(watch(), true);
  actual = 'invalid';
  assert.equal(watch(), true);
  actual = '2025-01-01T00:00:05.000Z';
  assert.equal(watch(), false);
});

test('watchParent: 生存・不明の観測で死亡カウンタをリセットする', () => {
  let state = 'alive';
  const api = createLiveness({ probePid: () => state, readStartTime: () => time });
  const watch = api.watchParent(api.captureProcess(123));
  state = 'dead'; assert.equal(watch(), true); assert.equal(watch(), true);
  state = 'unknown'; assert.equal(watch(), true);
  state = 'dead'; assert.equal(watch(), true); assert.equal(watch(), true);
  state = 'alive'; assert.equal(watch(), true);
  state = 'dead'; assert.equal(watch(), true); assert.equal(watch(), true); assert.equal(watch(), false);
});

test('セッション記録の参照は形式変換後も同一', () => {
  const api = createLiveness({ readStartTime: () => time, probePid: () => 'alive' });
  const ref = api.captureProcess(123);
  const record = api.writeRef({ issue: 7 }, ref, 'session');
  assert.deepEqual(record, { issue: 7, sessionPid: 123, sessionStartTime: time });
  assert.equal(api.sameRef(ref, api.readRef(record, 'session')), true);
  assert.throws(() => api.writeRef({}, ref, 'unsupported'));
});

test('真偽値や空文字を PID に変換しない', () => {
  const api = createLiveness({ readStartTime: () => time, probePid: () => 'alive' });
  for (const pid of [true, false, '', ' ', null, {}]) {
    assert.throws(() => api.captureProcess(pid), /invalid process identifier/);
    assert.equal(api.observe(api.readRef({ pid, startTime: time })), 'unknown');
  }
});

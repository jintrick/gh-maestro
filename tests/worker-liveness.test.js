'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const worker = require('../scripts/shared/worker-liveness');
const { createLiveness } = require('../scripts/shared/process-liveness');
const START = '2026-07-25T00:00:00.000Z';
afterEach(() => worker._setLiveness(null));
function useInputs(probePid, readStartTime) {
  worker._setLiveness(createLiveness({ probePid, readStartTime }));
}
test('同じプロセスなら稼働中と判定する', () => {
  useInputs(() => 'alive', () => START);
  assert.equal(worker.isWorkerAlive({ pid: 4242, startTime: START }), true);
});
test('死亡またはPID再利用の場合は稼働中と判定しない', () => {
  useInputs(() => 'dead', () => START);
  assert.equal(worker.isWorkerAlive({ pid: 4242, startTime: START }), false);
  useInputs(() => 'alive', () => '2026-07-26T00:00:00.000Z');
  assert.equal(worker.isWorkerAlive({ pid: 4242, startTime: START }), false);
});
test('識別情報欠落、取得失敗、照会失敗は稼働中と判定しない', () => {
  useInputs(() => 'alive', () => null);
  assert.equal(worker.isWorkerAlive({ pid: 4242 }), false);
  assert.equal(worker.isWorkerAlive({ pid: 4242, startTime: START }), false);
  useInputs(() => 'unknown', () => START);
  assert.equal(worker.isWorkerAlive({ pid: 4242, startTime: START }), false);
  assert.equal(worker.isWorkerAlive(null), false);
});
test('数値文字列の PID は読み込める', () => {
  useInputs(() => 'alive', () => START);
  assert.equal(worker.isWorkerAlive({ pid: '4242', startTime: START }), true);
});

'use strict';

const { installLivenessTestAdapter } = require('./helpers/process-liveness-test-double');
installLivenessTestAdapter();
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
test('resourceが死亡していれば稼働中と判定しない', () => {
  useInputs(() => 'dead', () => START);
  assert.equal(worker.isWorkerAlive({ pid: 4242, resourceKey: 'dead-resource' }), false);
});
test('識別情報欠落、取得失敗、照会失敗はunknownになり、稼働確認を伴う処理を止める', () => {
  useInputs(() => 'unknown', () => null);
  assert.equal(worker.observeWorker({ pid: 4242, resourceKey: null }), 'unknown');
  assert.throws(() => worker.isWorkerAlive({ pid: 4242, resourceKey: null }), /liveness is unknown/);
  assert.equal(worker.observeWorker({ pid: 4242, resourceKey: 'unknown-resource' }), 'unknown');
  assert.throws(() => worker.isWorkerAlive({ pid: 4242, resourceKey: 'unknown-resource' }), /liveness is unknown/);
  useInputs(() => 'unknown', () => START);
  assert.equal(worker.observeWorker({ pid: 4242, resourceKey: 'unknown-resource' }), 'unknown');
  assert.throws(() => worker.isWorkerAlive({ pid: 4242, resourceKey: 'unknown-resource' }), /liveness is unknown/);
  assert.equal(worker.observeWorker({ agentId: 'sleeping' }), 'dead');
  assert.equal(worker.isWorkerAlive({ agentId: 'sleeping' }), false);
  assert.equal(worker.observeWorker(null), 'unknown');
  assert.throws(() => worker.isWorkerAlive(null), /liveness is unknown/);
});
test('不正なPIDは欠落したPIDへ縮退せずunknownになる', () => {
  useInputs(() => 'alive', () => START);
  assert.equal(worker.observeWorker({ pid: 'not-a-pid', agentId: 'worker' }), 'unknown');
  assert.throws(() => worker.isWorkerAlive({ pid: 'not-a-pid', agentId: 'worker' }), /liveness is unknown/);
  assert.equal(worker.observeWorker({ pid: true, agentId: 'worker' }), 'unknown');
  assert.equal(worker.observeWorker({ pid: null, startTime: 0 }), 'unknown');
});
test('数値文字列の PID は読み込める', () => {
  useInputs(() => 'alive', () => START);
  assert.equal(worker.isWorkerAlive({ pid: '4242', startTime: START }), true);
});

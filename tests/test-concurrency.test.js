'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveDynamicConcurrency } = require('../scripts/shared/test-concurrency');

const DECLARATION = {
  cpuReserve: 1,
  reviewJobCost: 2,
  minimum: 1,
};

test('resolveDynamicConcurrency: CPU数と稼働中review-job数から下限付きで並列数を決める', () => {
  const run = reviewJobCount => resolveDynamicConcurrency({
    declaration: DECLARATION,
    workspace: 'C:/workspace',
  }, {
    availableParallelismFn: () => 12,
    findRunningInstancesFn: (workspace, options) => {
      assert.equal(workspace, 'C:/workspace');
      assert.deepEqual(options, { script: 'review-job', failOnReadError: true });
      return Array.from({ length: reviewJobCount }, () => ({}));
    },
  });

  assert.deepEqual(run(0), {
    value: 11,
    cpuCount: 12,
    reviewJobCount: 0,
    status: 'complete',
    unavailableInputs: [],
  });
  assert.deepEqual(run(3), {
    value: 5,
    cpuCount: 12,
    reviewJobCount: 3,
    status: 'complete',
    unavailableInputs: [],
  });
});

test('resolveDynamicConcurrency: 設定した最低値より小さくならない', () => {
  const result = resolveDynamicConcurrency({
    declaration: { ...DECLARATION, minimum: 2, cpuReserve: 8 },
    workspace: 'C:/workspace',
  }, {
    availableParallelismFn: () => 4,
    findRunningInstancesFn: () => [{}, {}],
  });

  assert.equal(result.value, 2);
  assert.equal(result.status, 'complete');
});

test('resolveDynamicConcurrency: review-job状態の読取失敗は0件扱いせず下限へ落として記録する', () => {
  const result = resolveDynamicConcurrency({
    declaration: { ...DECLARATION, minimum: 2 },
    workspace: 'C:/workspace',
  }, {
    availableParallelismFn: () => 12,
    findRunningInstancesFn: (_workspace, options) => {
      assert.deepEqual(options, { script: 'review-job', failOnReadError: true });
      throw new Error('registry read failed');
    },
  });

  assert.deepEqual(result, {
    value: 2,
    cpuCount: 12,
    reviewJobCount: null,
    status: 'unavailable',
    unavailableInputs: ['reviewJobCount'],
  });
});

test('resolveDynamicConcurrency: CPU数を取得できない場合も既知の入力を保持して下限で実行する', () => {
  const result = resolveDynamicConcurrency({
    declaration: { ...DECLARATION, minimum: 3 },
    workspace: 'C:/workspace',
  }, {
    availableParallelismFn: () => { throw new Error('CPU query failed'); },
    findRunningInstancesFn: () => [{}, {}],
  });

  assert.deepEqual(result, {
    value: 3,
    cpuCount: null,
    reviewJobCount: 2,
    status: 'unavailable',
    unavailableInputs: ['cpuCount'],
  });
});

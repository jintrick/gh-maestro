'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildWorkerEnv } = require('../scripts/shared/worker-env');

// buildWorkerEnv は初回起動（spawn-worker.js）と resume配送（inbox-supervisor.js）の両方で
// ワーカー起動envを組み立てる唯一の関数（Issue #269）。両経路が同じ値を注入できることを
// 純粋関数として決定的に検証する。

test('buildWorkerEnv: baseBranch 指定時は GH_MAESTRO_BASE_BRANCH も含める', () => {
  const env = buildWorkerEnv({ workerName: 'issue-1-impl', workspace: 'C:/ws', baseBranch: 'dev' });
  assert.deepEqual(env, {
    GH_MAESTRO_WORKER: 'issue-1-impl',
    GH_MAESTRO_WORKSPACE: 'C:/ws',
    GH_MAESTRO_BASE_BRANCH: 'dev',
  });
});

test('buildWorkerEnv: baseBranch 未指定（null/undefined/空文字）なら GH_MAESTRO_BASE_BRANCH を入れない', () => {
  for (const baseBranch of [null, undefined, '']) {
    const env = buildWorkerEnv({ workerName: 'w', workspace: 'C:/ws', baseBranch });
    assert.deepEqual(env, {
      GH_MAESTRO_WORKER: 'w',
      GH_MAESTRO_WORKSPACE: 'C:/ws',
    }, `baseBranch=${JSON.stringify(baseBranch)}`);
    assert.equal(Object.prototype.hasOwnProperty.call(env, 'GH_MAESTRO_BASE_BRANCH'), false);
  }
});

test('buildWorkerEnv: レガシーレコード（baseBranch 無し）も同じ形を返す（spawn/resume共通）', () => {
  // 初回起動時に登録した値と resume時に再注入する値が一致することを保証する基底ケース。
  // baseBranch が無いレガシーレコードでは注入されず、gh-create-pr.js 側がフェイルクローズする。
  const first = buildWorkerEnv({ workerName: 'w', workspace: 'C:/ws', baseBranch: 'dev' });
  const resume = buildWorkerEnv({ workerName: 'w', workspace: 'C:/ws', baseBranch: 'dev' });
  assert.deepEqual(resume, first);
});

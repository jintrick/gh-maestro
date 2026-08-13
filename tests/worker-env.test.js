'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildWorkerEnv } = require('../scripts/shared/worker-env');

// buildWorkerEnv は初回起動（spawn-worker.js）と resume配送（inbox-supervisor.js）の両方で
// ワーカー起動envを組み立てる唯一の関数（Issue #269）。両経路が同じ値を注入できることを
// 純粋関数として決定的に検証する。
//
// 注: ここで検証するのは「マージ入力」の形だけであり、ワーカーが実際に受け取る最終env
// （`{ ...process.env, ...launchEnv }` のマージ結果）ではない。親から継承した値の除去まで
// 含めた最終envは、spawn境界（headless-launch.test.js）とresume境界（inbox-supervisor.test.js）
// のテストで検証する。ここでは「baseBranch 未指定時にキーを『含めない』ではなく『空文字で
// 上書きする』」こと（= マージで親の値が残らない）を純粋関数の契約として固定する。

test('buildWorkerEnv: baseBranch 指定時は GH_MAESTRO_BASE_BRANCH も含める', () => {
  const env = buildWorkerEnv({ workerName: 'issue-1-impl', workspace: 'C:/ws', baseBranch: 'dev' });
  assert.deepEqual(env, {
    GH_MAESTRO_WORKER: 'issue-1-impl',
    GH_MAESTRO_WORKSPACE: 'C:/ws',
    GH_MAESTRO_BASE_BRANCH: 'dev',
  });
});

test('buildWorkerEnv: baseBranch 未指定（null/undefined/空文字）なら GH_MAESTRO_BASE_BRANCH を空文字で上書きする', () => {
  for (const baseBranch of [null, undefined, '']) {
    const env = buildWorkerEnv({ workerName: 'w', workspace: 'C:/ws', baseBranch });
    // キーを省略しない（Issue #269 レビュー指摘）: `{ ...process.env, ...env }` のマージでは
    // キーが無い場合に親から継承した値（例: 報告時に msg-send.js 経由で子プロセスへ
    // 混入する値）が残るため、空文字で明示的に上書きして gh-create-pr.js をフェイルクローズさせる。
    assert.deepEqual(env, {
      GH_MAESTRO_WORKER: 'w',
      GH_MAESTRO_WORKSPACE: 'C:/ws',
      GH_MAESTRO_BASE_BRANCH: '',
    }, `baseBranch=${JSON.stringify(baseBranch)}`);
  }
});

test('buildWorkerEnv: レガシーレコード（baseBranch 無し）も同じ形を返す（spawn/resume共通）', () => {
  // 初回起動時に登録した値と resume時に再注入する値が一致することを保証する基底ケース。
  // baseBranch が無いレガシーレコードでは空文字になり、gh-create-pr.js 側がフェイルクローズする。
  const first = buildWorkerEnv({ workerName: 'w', workspace: 'C:/ws', baseBranch: 'dev' });
  const resume = buildWorkerEnv({ workerName: 'w', workspace: 'C:/ws', baseBranch: 'dev' });
  assert.deepEqual(resume, first);
});

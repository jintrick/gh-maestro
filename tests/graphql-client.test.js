'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const gql = require('../scripts/shared/graphql-client');

// child-process の spawnSync だけを差し替えて graphql-client を読み直す（既定実装の argv を観測する）
function loadGraphqlClientWithSpawn(fakeSpawnSync) {
  const cpPath = require.resolve('../scripts/shared/child-process');
  const gcPath = require.resolve('../scripts/shared/graphql-client');
  const savedCp = require.cache[cpPath];
  const savedGc = require.cache[gcPath];
  require.cache[cpPath] = { id: cpPath, filename: cpPath, loaded: true, exports: { spawnSync: fakeSpawnSync } };
  delete require.cache[gcPath];
  try {
    return require(gcPath);
  } finally {
    if (savedCp) require.cache[cpPath] = savedCp; else delete require.cache[cpPath];
    if (savedGc) require.cache[gcPath] = savedGc; else delete require.cache[gcPath];
  }
}

test('graphqlExec: 既定実装は gh api graphql を引数付きで spawnSync に渡す／注入した実装も graphqlExec 経由で呼ばれる', () => {
  // 既定実装: 実ghを起動せず、spawnSync に渡る argv と opts を固定する（期待値は仕様上の形）
  const spawned = [];
  const fresh = loadGraphqlClientWithSpawn((cmd, args, opts) => {
    spawned.push({ cmd, args, opts });
    return { status: 0, stdout: '{}', stderr: '' };
  });
  const result = fresh.graphqlExec(['-f', 'query={}'], { input: 'body' });
  assert.equal(result.status, 0);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].cmd, 'gh');
  assert.deepEqual(spawned[0].args, ['api', 'graphql', '-f', 'query={}']);
  assert.equal(spawned[0].opts.input, 'body');
  assert.equal(spawned[0].opts.encoding, 'utf8');

  // 注入の口: 注入した実装が graphqlExec 経由で呼ばれる（旧 6 の検査を統合）
  let injectedCalled = false;
  gql._setGraphqlExec(() => { injectedCalled = true; return { status: 0, stdout: '{}' }; });
  gql.graphqlExec([]);
  assert.equal(injectedCalled, true);
});

test('parseGraphqlJson: 有効JSONをパースする', () => {
  assert.deepEqual(gql.parseGraphqlJson('{"data":{"x":1}}'), { data: { x: 1 } });
});

test('parseGraphqlJson: 不正JSONはnullを返す', () => {
  assert.equal(gql.parseGraphqlJson('not json'), null);
  assert.equal(gql.parseGraphqlJson(''), null);
  assert.equal(gql.parseGraphqlJson(undefined), null);
});

test('hasGraphqlErrors: errors配列がある応答を検出する', () => {
  assert.equal(gql.hasGraphqlErrors({ errors: [{ message: 'boom' }] }), true);
  assert.equal(gql.hasGraphqlErrors({ errors: [] }), false);
  assert.equal(gql.hasGraphqlErrors({ data: {} }), false);
  assert.equal(gql.hasGraphqlErrors(null), false);
  assert.equal(gql.hasGraphqlErrors(undefined), false);
});

test('isGraphqlSuccess: status 0 かつ errors無しのみ成功', () => {
  assert.equal(gql.isGraphqlSuccess({ status: 0, stdout: '{"data":{}}' }), true);
  assert.equal(gql.isGraphqlSuccess({ status: 0, stdout: '{"errors":[{"message":"x"}]}' }), false);
  assert.equal(gql.isGraphqlSuccess({ status: 1, stdout: '{"data":{}}' }), false);
  assert.equal(gql.isGraphqlSuccess({ status: 0, stdout: 'not json' }), false);
  assert.equal(gql.isGraphqlSuccess(null), false);
});


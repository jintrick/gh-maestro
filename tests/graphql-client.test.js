'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const gql = require('../scripts/shared/graphql-client');

test('graphqlExec: デフォルト実装は gh api graphql を spawnSync で呼ぶ（未注入時は実ghへの引数構築を検証）', () => {
  // 実ghを起動したくないため、setterで注入して呼び出しを観測する。
  const calls = [];
  gql._setGraphqlExec((args, opts) => {
    calls.push({ args, opts });
    return { status: 0, stdout: '{}', stderr: '' };
  });

  const result = gql.graphqlExec(['-f', 'query={}'], { input: 'body' });
  assert.equal(result.status, 0);
  assert.deepEqual(calls.length, 1);
  assert.equal(calls[0].args[0], '-f');
  assert.equal(calls[0].args[1], 'query={}');
  assert.equal(calls[0].opts.input, 'body');
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

test('_setGraphqlExec: 注入した実装は graphqlExec 経由で呼ばれる', () => {
  let injectedCalled = false;
  gql._setGraphqlExec(() => { injectedCalled = true; return { status: 0, stdout: '{}' }; });
  gql.graphqlExec([]);
  assert.equal(injectedCalled, true);
});

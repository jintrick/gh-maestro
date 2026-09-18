'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TARGETS, parseArgs, main } = require('../scripts/run-lint');

test('run-lint: 対象はscriptsとtestsのJavaScriptだけである', () => {
  assert.deepEqual(TARGETS, ['scripts/**/*.js', 'tests/**/*.js']);
});

test('run-lint: --helpはlint実行なしで終了コード0を返す', async () => {
  const result = await main(['--help']);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Usage/);
});

test('run-lint: 不明な引数は終了コード1で拒否する', () => {
  assert.throws(() => parseArgs(['--unknown']), /未知の引数/);
});

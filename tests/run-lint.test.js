'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TARGETS, SPEC, parseArgs, main } = require('../scripts/run-lint');

test('run-lint: 対象はscriptsとtestsのJavaScriptだけである', () => {
  assert.deepEqual(TARGETS, ['scripts/**/*.js', 'tests/**/*.js']);
});

test('run-lint: --helpはlint実行なしで終了コード0を返す', async () => {
  const result = await main(['--help']);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Usage/);
});

test('run-lint: parseFlagsの仕様で重複・余分な位置引数を拒否する', async () => {
  assert.deepEqual(SPEC.positionals, { min: 0, max: 0 });
  assert.throws(() => parseArgs(['--format', 'json', '--format', 'compact']), /重複/);
  const result = await main(['extra']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /位置引数/);
});

test('run-lint: parseFlagsのhelpRequestedで未知引数とhelpをUsageへ導く', async () => {
  const result = await main(['--unknown', '--help']);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Usage:/);
});

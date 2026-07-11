'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// poll-reviews.js のポーリング本体は require.main === module でガードされているため、
// require するだけでは実プロセスをspawnしない（.claude/rules/test-process-spawn-safety.md 準拠）。
const { parseArgs } = require('../scripts/poll-reviews');

test('位置引数とフラグを通常どおりパースする', () => {
  const r = parseArgs(['42', '/ws', '10', '--session-pid', '999']);
  assert.equal(r.help, false);
  assert.equal(r.sessionPid, '999');
  assert.deepEqual(r.positional, ['42', '/ws', '10']);
});

test('--help はヘルプフラグとして認識される', () => {
  const r = parseArgs(['--help']);
  assert.equal(r.help, true);
});

test('--session-pid の値が"--help"文字列でもフラグとして誤解釈しない', () => {
  const r = parseArgs(['42', '--session-pid', '--help']);
  assert.equal(r.help, false);
  assert.equal(r.sessionPid, '--help');
  assert.deepEqual(r.positional, ['42']);
});

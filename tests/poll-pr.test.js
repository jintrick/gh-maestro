'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// poll-pr.js のポーリング本体は require.main === module でガードされているため、
// require するだけでは実プロセスをspawnしない（.claude/rules/test-process-spawn-safety.md 準拠）。
const { parseArgs } = require('../scripts/poll-pr');

test('位置引数とフラグを通常どおりパースする', () => {
  const r = parseArgs(['86', '--workspace', '/ws', '--session-pid', '123', '10']);
  assert.equal(r.help, false);
  assert.equal(r.workspace, '/ws');
  assert.equal(r.sessionPid, '123');
  assert.deepEqual(r.positional, ['86', '10']);
});

test('--help はヘルプフラグとして認識される', () => {
  const r = parseArgs(['--help']);
  assert.equal(r.help, true);
});

test('--workspace の値が"--help"文字列でもフラグとして誤解釈しない', () => {
  const r = parseArgs(['86', '--workspace', '--help']);
  assert.equal(r.help, false);
  assert.equal(r.workspace, '--help');
  assert.deepEqual(r.positional, ['86']);
});

test('--session-pid の値が"--workspace"文字列でも別フラグとして誤解釈しない', () => {
  const r = parseArgs(['86', '--session-pid', '--workspace', '--workspace', '/ws']);
  assert.equal(r.sessionPid, '--workspace');
  assert.equal(r.workspace, '/ws');
});

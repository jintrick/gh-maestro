'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// remove-worker.js の実行本体は require.main === module でガードされているため、
// require するだけでは実プロセスをspawnしない（.claude/rules/test-process-spawn-safety.md 準拠）。
const { parseArgs } = require('../scripts/remove-worker');

test('--worker-name と --workspace を通常どおりパースする', () => {
  const r = parseArgs(['--worker-name', 'issue-1-test', '--workspace', '/ws']);
  assert.equal(r.help, false);
  assert.equal(r.workerName, 'issue-1-test');
  assert.equal(r.workspace, '/ws');
});

test('--help はヘルプフラグとして認識される', () => {
  const r = parseArgs(['--help']);
  assert.equal(r.help, true);
});

test('--worker-name の値が"--help"文字列でもフラグとして誤解釈しない', () => {
  const r = parseArgs(['--worker-name', '--help', '--workspace', '/ws']);
  assert.equal(r.help, false);
  assert.equal(r.workerName, '--help');
  assert.equal(r.workspace, '/ws');
});

test('--workspace の値が"--worker-name"文字列でも別フラグとして誤解釈しない', () => {
  const r = parseArgs(['--workspace', '--worker-name', '--worker-name', 'foo']);
  assert.equal(r.workspace, '--worker-name');
  assert.equal(r.workerName, 'foo');
});

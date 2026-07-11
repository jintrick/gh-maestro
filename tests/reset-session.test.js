'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// reset-session.js の実行本体は require.main === module でガードされているため、
// require するだけでは実プロセスをspawnしない（.claude/rules/test-process-spawn-safety.md 準拠）。
const { parseArgs } = require('../scripts/reset-session');

test('--workspace と --quiet を通常どおりパースする', () => {
  const r = parseArgs(['--workspace', '/ws', '--quiet']);
  assert.equal(r.help, false);
  assert.equal(r.workspace, '/ws');
  assert.equal(r.quiet, true);
});

test('--help はヘルプフラグとして認識される', () => {
  const r = parseArgs(['--help']);
  assert.equal(r.help, true);
});

test('--workspace の値が"--quiet"文字列でもフラグとして誤解釈しない', () => {
  const r = parseArgs(['--workspace', '--quiet']);
  assert.equal(r.workspace, '--quiet');
  assert.equal(r.quiet, false);
});

test('--workspace の値が"--help"文字列でもフラグとして誤解釈しない', () => {
  const r = parseArgs(['--workspace', '--help']);
  assert.equal(r.help, false);
  assert.equal(r.workspace, '--help');
});

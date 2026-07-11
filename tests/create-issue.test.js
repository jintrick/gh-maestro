'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// create-issue.js の CLI 実行部は require.main === module でガードされているため、
// require するだけでは gh コマンドを実行しない（.claude/rules/test-process-spawn-safety.md 準拠）。
const { parseArgs } = require('../scripts/create-issue');

test('--title と --body-file を通常どおりパースする', () => {
  const r = parseArgs(['--title', 'hello', '--body-file', '/tmp/x.md']);
  assert.equal(r.help, false);
  assert.equal(r.title, 'hello');
  assert.equal(r.bodyFile, '/tmp/x.md');
  assert.deepEqual(r.positionals, []);
});

test('--help はヘルプフラグとして認識される', () => {
  const r = parseArgs(['--help']);
  assert.equal(r.help, true);
});

test('--title の値が"--help"文字列でもフラグとして誤解釈しない', () => {
  const r = parseArgs(['--title', '--help', '--body-file', '/tmp/x.md']);
  assert.equal(r.help, false);
  assert.equal(r.title, '--help');
  assert.equal(r.bodyFile, '/tmp/x.md');
});

test('--body-file の値が"-h"文字列でもフラグとして誤解釈しない', () => {
  const r = parseArgs(['--title', 't', '--body-file', '-h']);
  assert.equal(r.help, false);
  assert.equal(r.bodyFile, '-h');
});

test('--title の値が"--repo"文字列でも別フラグとして誤解釈しない', () => {
  const r = parseArgs(['--title', '--repo', '--body-file', '/tmp/x.md', '--repo', 'o/r']);
  assert.equal(r.title, '--repo');
  assert.equal(r.bodyFile, '/tmp/x.md');
  assert.equal(r.repo, 'o/r');
});

test('余分な位置引数はpositionalsに記録される', () => {
  const r = parseArgs(['--title', 't', '--body-file', 'f', 'extra']);
  assert.deepEqual(r.positionals, ['extra']);
});

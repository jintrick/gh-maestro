'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  TEST_RESULT_MARKER,
  USAGE,
  buildCommentBody,
  declareTestResult,
  main,
} = require('../../scripts/declare-test-result');

const MARKER = TEST_RESULT_MARKER;
const SHA = 'a1b2c3d4e5f67890123456789012345678901234';
const CONTENT_HASH = 'a'.repeat(64);
const RESULT = {
  provenance: 'test-runner',
  scope: 'full',
  tests: 1826,
  pass: 1826,
  fail: 0,
  testedContentHash: CONTENT_HASH,
};

function githubResult(htmlUrl) {
  return { status: 0, stdout: JSON.stringify({ html_url: htmlUrl }), stderr: '' };
}

function baseDeps(overrides = {}) {
  return {
    gitHeadFn: () => SHA,
    readTestResultFn: () => ({ ok: true, result: RESULT }),
    ghListCommentsFn: () => ({ status: 0, stdout: '[]', stderr: '' }),
    ghCreateCommentFn: () => githubResult('https://github.com/owner/repo/pull/42#issuecomment-1'),
    ghUpdateCommentFn: () => githubResult('https://github.com/owner/repo/pull/42#issuecomment-1'),
    commitContentHashFn: () => CONTENT_HASH,
    ...overrides,
  };
}

















// CLIの実行例が実際にusageを出すことだけを、非再帰の境界テストとして確認する。
test('declare-test-result.js: サブプロセス経由 --help で終了コード0', () => {
  const { spawnSync } = require('child_process');
  const path = require('path');
  const script = path.join(__dirname, '..', '..', 'scripts', 'declare-test-result.js');
  const result = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes(USAGE));
});

test('declare-test-result.js: サブプロセス経由の引数不足は終了コード1', () => {
  const { spawnSync } = require('child_process');
  const path = require('path');
  const script = path.join(__dirname, '..', '..', 'scripts', 'declare-test-result.js');
  const result = spawnSync(process.execPath, [script, '--repo', 'owner/repo'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /必須/);
});

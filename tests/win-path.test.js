'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toWinPath } = require('../scripts/win-path');

test('Windowsパスはそのまま返す', () => {
  assert.equal(toWinPath('C:\\Users\\amg\\foo.md'), 'C:\\Users\\amg\\foo.md');
});

test('相対パスはそのまま返す', () => {
  assert.equal(toWinPath('foo/bar.md'), 'foo/bar.md');
});

test('/c/Users/... 形式をドライブレター形式に変換する', () => {
  const result = toWinPath('/c/Users/amg/foo.md');
  assert.equal(result, 'C:\\Users\\amg\\foo.md');
});

test('/tmp/... 形式を%TEMP%パスに変換する', () => {
  const temp = process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp';
  const result = toWinPath('/tmp/pr-diff.txt');
  assert.ok(
    result.startsWith(temp) || result.endsWith('pr-diff.txt'),
    `expected to start with TEMP dir, got: ${result}`
  );
  assert.ok(result.endsWith('pr-diff.txt'), `expected to end with filename, got: ${result}`);
});

test('/tmp/サブディレクトリ/ファイル も正しく変換する', () => {
  const temp = process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp';
  const result = toWinPath('/tmp/sub/foo.md');
  assert.ok(result.endsWith('sub\\foo.md'), `unexpected: ${result}`);
});

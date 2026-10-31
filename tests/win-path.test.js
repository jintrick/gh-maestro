'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toWinPath } = require('../scripts/shared/win-path');

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

// cygpath を失敗させ、フォールバック（%TEMP% への写像）を決定的に通す
function loadWinPathWithoutCygpath() {
  const cpPath = require.resolve('../scripts/shared/child-process');
  const wpPath = require.resolve('../scripts/shared/win-path');
  const savedCp = require.cache[cpPath];
  const savedWp = require.cache[wpPath];
  require.cache[cpPath] = {
    id: cpPath, filename: cpPath, loaded: true,
    exports: { spawnSync: () => ({ status: 1, stdout: '', stderr: '' }) },
  };
  delete require.cache[wpPath];
  try {
    return require(wpPath);
  } finally {
    if (savedCp) require.cache[cpPath] = savedCp; else delete require.cache[cpPath];
    if (savedWp) require.cache[wpPath] = savedWp; else delete require.cache[wpPath];
  }
}

test('/tmp/... 形式を%TEMP%へ写像する（直下とサブディレクトリの両方、区切りはバックスラッシュ）', () => {
  const temp = process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp';
  const { toWinPath: fallback } = loadWinPathWithoutCygpath();
  assert.equal(fallback('/tmp/pr-diff.txt'), `${temp}\\pr-diff.txt`);
  assert.equal(fallback('/tmp/sub/foo.md'), `${temp}\\sub\\foo.md`);
});

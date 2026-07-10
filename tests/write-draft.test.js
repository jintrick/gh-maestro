'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { main } = require('../scripts/write-draft');
const { toWinPath } = require('../scripts/win-path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'write-draft.js');

test('論理パス引数がないとUsageエラー', () => {
  const r = main(['--body', 'hello']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Usage/);
});

test('--body も --stdin も無いとUsageエラー', () => {
  const r = main(['/tmp/foo.md']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Usage/);
});

test('--body と --stdin を両方指定するとUsageエラー', () => {
  const r = main(['/tmp/foo.md', '--body', 'x', '--stdin']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Usage/);
});

test('--help はUsageを表示して終了コード0', () => {
  const r = main(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Usage/);
});

test('空文字の --body はエラーになる（サイレント失敗防止）', () => {
  const r = main(['/tmp/foo.md', '--body', '']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /空です/);
});

test('--body の内容を実体パスへ書き込み、実体パスを報告する', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'write-draft-test-'));
  const logicalPath = path.join(tmpDir, 'sub', 'draft.md');
  const r = main([logicalPath, '--body', 'hello world']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^DRAFT_WRITTEN:/);
  const absPath = path.resolve(toWinPath(logicalPath));
  assert.equal(fs.readFileSync(absPath, 'utf8'), 'hello world');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('既存ファイルは上書きされる', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'write-draft-test-'));
  const logicalPath = path.join(tmpDir, 'draft.md');
  main([logicalPath, '--body', 'first']);
  const r = main([logicalPath, '--body', 'second']);
  assert.equal(r.code, 0);
  const absPath = path.resolve(toWinPath(logicalPath));
  assert.equal(fs.readFileSync(absPath, 'utf8'), 'second');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('--stdin から内容を読み込んで書き込む', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'write-draft-test-'));
  const logicalPath = path.join(tmpDir, 'draft.md');
  const r = main([logicalPath, '--stdin'], { readStdinFn: () => 'from stdin' });
  assert.equal(r.code, 0);
  const absPath = path.resolve(toWinPath(logicalPath));
  assert.equal(fs.readFileSync(absPath, 'utf8'), 'from stdin');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('サブプロセス経由: 引数なしはUsageエラーで終了コード1', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage/);
});

test('サブプロセス経由: --helpは終了コード0', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage/);
});

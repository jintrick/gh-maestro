'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { main } = require('../../scripts/write-draft');
const { toWinPath } = require('../../scripts/shared/win-path');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'write-draft.js');

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
  const r = main([logicalPath, '--stdin'], {
    readStdinFn: () => 'from stdin',
    isStdinTTY: () => false,
  });
  assert.equal(r.code, 0);
  const absPath = path.resolve(toWinPath(logicalPath));
  assert.equal(fs.readFileSync(absPath, 'utf8'), 'from stdin');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('--stdin指定時、標準入力がTTYだとエラーで即終了する（ハング防止）', () => {
  const r = main(['/tmp/foo.md', '--stdin'], {
    readStdinFn: () => {
      throw new Error('readStdinFn should not be called when stdin is a TTY');
    },
    isStdinTTY: () => true,
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /TTY/);
});

test('位置引数が2個以上あるとUsageエラー（誤用検知）', () => {
  const r = main(['/tmp/foo.md', 'extra-arg', '--body', 'hello']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Usage/);
});

test('--body の値が"--help"文字列でもフラグとして誤解釈しない', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'write-draft-test-'));
  const logicalPath = path.join(tmpDir, 'draft.md');
  const r = main([logicalPath, '--body', '--help']);
  assert.equal(r.code, 0);
  const absPath = path.resolve(toWinPath(logicalPath));
  assert.equal(fs.readFileSync(absPath, 'utf8'), '--help');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('--body の値が"--stdin"文字列でもフラグとして誤解釈しない', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'write-draft-test-'));
  const logicalPath = path.join(tmpDir, 'draft.md');
  const r = main([logicalPath, '--body', '--stdin'], {
    readStdinFn: () => {
      throw new Error('--bodyが指定されているのにstdinを読んではならない');
    },
  });
  assert.equal(r.code, 0);
  const absPath = path.resolve(toWinPath(logicalPath));
  assert.equal(fs.readFileSync(absPath, 'utf8'), '--stdin');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('/tmp/../issue-draft.md のようなpath traversalは拒否される', () => {
  const r = main(['/tmp/../issue-draft-traversal-test.md', '--body', 'x']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /許可ルート/);
  const escaped = path.resolve(path.dirname(path.resolve(toWinPath('/tmp'))), 'issue-draft-traversal-test.md');
  assert.equal(fs.existsSync(escaped), false);
});

test('/tmp/../../.git/config のようなpath traversalは拒否される', () => {
  const r = main(['/tmp/../../.git/config', '--body', 'x']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /許可ルート/);
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

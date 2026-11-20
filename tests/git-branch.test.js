'use strict';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const gitBranch = require('../scripts/shared/git-branch');
const { getCurrentBranch } = gitBranch;

describe('git-branch (unit with mock)', () => {
  afterEach(() => {
    gitBranch._setSpawnSync(require('../scripts/shared/child-process').spawnSync);
  });

  test('正常系: ブランチ名が正しく返される', () => {
    gitBranch._setSpawnSync((cmd, args, opts) => {
      assert.equal(cmd, 'git');
      assert.deepEqual(args, ['branch', '--show-current']);
      assert.equal(opts.cwd, '/mock/dir');
      return { status: 0, stdout: 'issue-378-branch\n', stderr: '' };
    });

    const branch = getCurrentBranch('/mock/dir');
    assert.equal(branch, 'issue-378-branch');
  });

  test('detached HEAD: 空文字列が返される', () => {
    gitBranch._setSpawnSync(() => ({ status: 0, stdout: '\n', stderr: '' }));

    const branch = getCurrentBranch('/mock/dir');
    assert.equal(branch, '');
  });

  test('git 失敗時: 例外が throw される（拒否・失敗側）', () => {
    gitBranch._setSpawnSync(() => ({ status: 128, stdout: '', stderr: 'fatal: not a git repository' }));

    assert.throws(
      () => getCurrentBranch('/mock/dir'),
      /git branch --show-current failed: fatal: not a git repository/
    );
  });

  test('spawn エラー時: 例外が throw される（拒否・失敗側）', () => {
    gitBranch._setSpawnSync(() => ({ error: new Error('spawn ENOENT') }));

    assert.throws(
      () => getCurrentBranch('/mock/dir'),
      /git branch --show-current failed: spawn ENOENT/
    );
  });

  test('引数不正時: dir が空や非文字列なら例外が throw される（拒否・失敗側）', () => {
    assert.throws(() => getCurrentBranch(''), /有効なディレクトリパスが必要です/);
    assert.throws(() => getCurrentBranch(null), /有効なディレクトリパスが必要です/);
    assert.throws(() => getCurrentBranch(123), /有効なディレクトリパスが必要です/);
  });
});

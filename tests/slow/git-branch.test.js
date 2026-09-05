'use strict';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const gitBranch = require('../../scripts/shared/git-branch');
const { getCurrentBranch } = gitBranch;

describe('git-branch (unit with mock)', () => {
  afterEach(() => {
    gitBranch._setSpawnSync(require('../../scripts/shared/child-process').spawnSync);
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

describe('git-branch (integration with real git repo)', () => {
  test('実リポジトリでのブランチ取得および detached HEAD', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-branch-test-'));
    try {
      execSync('git init -b feature-test', { cwd: tmp, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: tmp, stdio: 'pipe' });
      execSync('git config user.email "test@example.com"', { cwd: tmp, stdio: 'pipe' });

      // 初期ブランチ
      assert.equal(getCurrentBranch(tmp), 'feature-test');

      // コミットを作成して detached HEAD に移行
      fs.writeFileSync(path.join(tmp, 'file.txt'), 'hello');
      execSync('git add file.txt', { cwd: tmp, stdio: 'pipe' });
      execSync('git commit -m "initial"', { cwd: tmp, stdio: 'pipe' });

      const sha = execSync('git rev-parse HEAD', { cwd: tmp, encoding: 'utf8' }).trim();
      execSync(`git checkout ${sha}`, { cwd: tmp, stdio: 'pipe' });

      // detached HEAD では空文字
      assert.equal(getCurrentBranch(tmp), '');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

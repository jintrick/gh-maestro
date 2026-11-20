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

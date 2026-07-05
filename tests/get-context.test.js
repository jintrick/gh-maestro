'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'get-context.js');
const REPO_ROOT = path.join(__dirname, '..');

test('REPO と WORKSPACE を正しいフォーマットで出力する', () => {
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  // フォーマット: クォートなし、owner/repo形式
  assert.match(r.stdout, /^REPO=[^/\s]+\/[^\s]+/m);
  assert.match(r.stdout, /^WORKSPACE=.+/m);
});

test('WORKSPACE はカレントディレクトリと一致する（Unixスラッシュ）', () => {
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0);
  const match = r.stdout.match(/^WORKSPACE=(.+)/m);
  assert.ok(match, 'WORKSPACEが出力に含まれない');
  // スクリプトはWindowsパスをUnixスラッシュに変換して出力する
  const expected = REPO_ROOT.replace(/\\/g, '/');
  assert.equal(match[1].trim(), expected);
});

test('BASE_BRANCH が出力に含まれる', () => {
  const { mkdtempSync, writeFileSync, rmSync } = require('fs');
  const { execSync } = require('child_process');
  const os = require('os');

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-branch-'));
  try {
    // 既知のブランチを持つ git リポジトリ fixture を作成し、
    // detached HEAD 等の呼び出し元の状態に依存せず BASE_BRANCH が必ず出力される状態で検証する
    execSync('git init', { cwd: tmp, stdio: 'pipe' });
    execSync('git config user.email "test@test"', { cwd: tmp, stdio: 'pipe' });
    execSync('git config user.name "test"', { cwd: tmp, stdio: 'pipe' });
    writeFileSync(path.join(tmp, 'README'), 'test-fixture');
    execSync('git add README', { cwd: tmp, stdio: 'pipe' });
    execSync('git commit -m init', { cwd: tmp, stdio: 'pipe' });
    execSync('git remote add origin https://github.com/test/repo.git', { cwd: tmp, stdio: 'pipe' });

    const r = spawnSync(process.execPath, [SCRIPT], {
      cwd: tmp,
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
    assert.match(r.stdout, /^BASE_BRANCH=.+/m);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('git remote がないディレクトリでは非0終了する', () => {
  const { mkdtempSync } = require('fs');
  const os = require('os');
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-no-git-'));
  try {
    const r = spawnSync(process.execPath, [SCRIPT], {
      cwd: tmp,
      encoding: 'utf8',
    });
    assert.notEqual(r.status, 0);
  } finally {
    require('fs').rmSync(tmp, { recursive: true, force: true });
  }
});

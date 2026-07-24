'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'gh-maestro-setup.js');

// gh-maestro-setup.js は require.main===module ガードを持たず全体が top-level
// スクリプトのため、実プロセス起動（subprocess）でのみ検証する。checkEnvironment
// （WEZTERM_PANE/wezterm/gh 依存）は .gh-maestro/setup-ok を事前に置いて
// isFirstRun=false にすることでスキップする。

function withGitProject(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-setup-test-'));
  try {
    const git = (...args) => {
      const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
      assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
      return r;
    };
    git('init', '-q');
    git('config', 'user.email', 'test@test.com');
    git('config', 'user.name', 'test');
    fs.writeFileSync(path.join(dir, 'README.md'), 'x', 'utf8');
    git('add', 'README.md');
    git('commit', '-qm', 'init');
    git('branch', '-m', 'main');
    fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.gh-maestro', 'setup-ok'), '', 'utf8');
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runSetup(dir) {
  return spawnSync(process.execPath, [SCRIPT, dir], { cwd: dir, encoding: 'utf8' });
}

function readHook(dir, name) {
  return fs.readFileSync(path.join(dir, '.git', 'hooks', name), 'utf8');
}

test('新規プロジェクトにpre-commit/pre-pushフック両方を新規設置する', () => {
  withGitProject((dir) => {
    const r = runSetup(dir);
    assert.equal(r.status, 0, r.stderr);

    const preCommit = readHook(dir, 'pre-commit');
    assert.match(preCommit, /# gh-maestro:sync-rules:v1/);
    assert.match(preCommit, /# gh-maestro:checks:v1/);
    assert.match(preCommit, /run-checks\.js.*precommit \|\| exit 1/);

    const prePush = readHook(dir, 'pre-push');
    assert.match(prePush, /# gh-maestro:checks:v1/);
    assert.match(prePush, /run-checks\.js.*prepush \|\| exit 1/);
  });
});

test('2回連続実行しても内容が変化しない（冪等）', () => {
  withGitProject((dir) => {
    assert.equal(runSetup(dir).status, 0);
    const preCommitFirst = readHook(dir, 'pre-commit');
    const prePushFirst = readHook(dir, 'pre-push');

    assert.equal(runSetup(dir).status, 0);
    assert.equal(readHook(dir, 'pre-commit'), preCommitFirst);
    assert.equal(readHook(dir, 'pre-push'), prePushFirst);
  });
});

test('旧バージョンマーカーのchecksブロックは最新版へ置き換わる', () => {
  withGitProject((dir) => {
    const hookPath = path.join(dir, '.git', 'hooks', 'pre-commit');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, [
      '#!/bin/sh',
      '# gh-maestro:checks:v0',
      'echo old-behavior',
    ].join('\n') + '\n', 'utf8');

    const r = runSetup(dir);
    assert.equal(r.status, 0, r.stderr);

    const preCommit = readHook(dir, 'pre-commit');
    assert.doesNotMatch(preCommit, /old-behavior/);
    assert.match(preCommit, /# gh-maestro:checks:v1/);
    assert.match(preCommit, /run-checks\.js.*precommit \|\| exit 1/);
  });
});

test('旧ブロックの行数が新エントリと異なっていても、後続の別ブロックを巻き込まずに置き換わる', () => {
  // 旧checksブロックは3行本文（新エントリは1行）、かつ直後に別ブロックが続く状態を
  // 再現し、splice範囲が「新エントリの行数」ではなく「旧ブロックの実際の範囲（次の
  // 空行まで）」で決まることを検証する（固定長splice方式だと後続ブロックの先頭行を
  // 誤って巻き込む/取りこぼす）。
  withGitProject((dir) => {
    const hookPath = path.join(dir, '.git', 'hooks', 'pre-commit');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, [
      '#!/bin/sh',
      '# gh-maestro:checks:v0',
      'echo old-line-1',
      'echo old-line-2',
      'echo old-line-3',
      '',
      '# some-unrelated-marker',
      'echo unrelated-block-must-survive',
    ].join('\n') + '\n', 'utf8');

    const r = runSetup(dir);
    assert.equal(r.status, 0, r.stderr);

    const preCommit = readHook(dir, 'pre-commit');
    assert.doesNotMatch(preCommit, /old-line-1|old-line-2|old-line-3/);
    assert.match(preCommit, /# gh-maestro:checks:v1/);
    assert.match(preCommit, /run-checks\.js.*precommit \|\| exit 1/);
    // 後続の無関係なブロックが誤って削られていないこと
    assert.match(preCommit, /# some-unrelated-marker/);
    assert.match(preCommit, /echo unrelated-block-must-survive/);
  });
});

test('手書きの既存pre-commitフックがあってもgh-maestroブロックを末尾に追記する', () => {
  withGitProject((dir) => {
    const hookPath = path.join(dir, '.git', 'hooks', 'pre-commit');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, '#!/bin/sh\necho custom-user-hook\n', 'utf8');

    const r = runSetup(dir);
    assert.equal(r.status, 0, r.stderr);

    const preCommit = readHook(dir, 'pre-commit');
    assert.match(preCommit, /custom-user-hook/);
    assert.match(preCommit, /# gh-maestro:sync-rules:v1/);
    assert.match(preCommit, /# gh-maestro:checks:v1/);
  });
});

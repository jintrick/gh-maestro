'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { cleanSpawnEnv } = require('../_spawn-env');

const GIT_WORKTREE_MODULE = require.resolve('../../scripts/shared/git-worktree');

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanSpawnEnv() });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  return result;
}

function runWorktreeAdd(cwd, destination, branch) {
  const code = `try { require(${JSON.stringify(GIT_WORKTREE_MODULE)}).worktreeAdd(${JSON.stringify(destination)}, ${JSON.stringify(branch)}, null, process.cwd()); } catch (error) { process.stderr.write('CAUGHT: ' + error.message + '\\n'); process.exitCode = 7; }`;
  return spawnSync(process.execPath, ['-e', code], { cwd, encoding: 'utf8', env: cleanSpawnEnv() });
}

test('worktreeAdd passes quiet through to Git while preserving hook output and errors', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-git-worktree-add-'));
  try {
    git(repo, 'init');
    git(repo, 'config', 'user.name', 'gh-maestro test');
    git(repo, 'config', 'user.email', 'gh-maestro-test@example.invalid');
    fs.writeFileSync(path.join(repo, 'README.md'), 'test\n', 'utf8');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-m', 'initial');
    const currentBranch = git(repo, 'symbolic-ref', '--short', 'HEAD').stdout.trim();

    const hookDir = path.join(repo, 'hooks');
    fs.mkdirSync(hookDir);
    const hookPath = path.join(hookDir, 'post-checkout');
    fs.writeFileSync(hookPath, '#!/bin/sh\nprintf "HOOK_STDOUT\\n"\nprintf "HOOK_STDERR\\n" >&2\nexit 17\n', 'utf8');
    try { fs.chmodSync(hookPath, 0o755); } catch {}
    git(repo, 'config', 'core.hooksPath', hookDir);

    const destination = path.join(repo, 'actual-worktree');
    const success = runWorktreeAdd(repo, destination, 'quiet-output-test');
    assert.equal(success.status, 0, `${success.stdout}\n${success.stderr}`);
    assert.doesNotMatch(success.stdout, /Preparing worktree/);
    assert.match(success.stdout, /HOOK_STDOUT/);
    assert.match(success.stderr, /HOOK_STDERR/);
    assert.ok(fs.existsSync(path.join(destination, 'README.md')));

    const failure = runWorktreeAdd(repo, path.join(repo, 'failed-worktree'), currentBranch);
    assert.equal(failure.status, 7, `${failure.stdout}\n${failure.stderr}`);
    assert.match(failure.stderr, /already exists|already checked out/i);
    assert.match(failure.stderr, /CAUGHT:/);
    assert.doesNotMatch(failure.stdout, /Preparing worktree/);
  } finally {
    try { git(repo, 'worktree', 'remove', '--force', path.join(repo, 'actual-worktree')); } catch {}
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

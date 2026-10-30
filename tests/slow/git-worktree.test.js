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

function runNodeCode(cwd, code, winptyPath = null) {
  const command = winptyPath || process.execPath;
  const args = winptyPath ? [process.execPath, '-e', code] : ['-e', code];
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...cleanSpawnEnv(), GIT_PROGRESS_DELAY: '0' },
  });
}

function findWinpty() {
  const result = spawnSync('where.exe', ['winpty.exe'], { encoding: 'utf8' });
  assert.equal(result.status, 0, `winpty.exe is required to exercise Git's terminal progress: ${result.stderr}`);
  const winptyPath = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  assert.ok(winptyPath, 'where.exe must return a winpty.exe path');
  return winptyPath;
}

function runWorktreeAdd(cwd, destination, branch, winptyPath = null) {
  const code = `try { require(${JSON.stringify(GIT_WORKTREE_MODULE)}).worktreeAdd(${JSON.stringify(destination)}, ${JSON.stringify(branch)}, null, process.cwd()); } catch (error) { process.stderr.write('CAUGHT: ' + error.message + '\\n'); process.exitCode = 7; }`;
  return runNodeCode(cwd, code, winptyPath);
}

function runGitWorktreeAdd(cwd, destination, branch, winptyPath) {
  const args = ['-c', 'core.longpaths=true', 'worktree', 'add', destination, '-b', branch];
  const code = `const { spawnSync } = require('node:child_process'); const result = spawnSync('git', ${JSON.stringify(args)}, { cwd: process.cwd(), stdio: 'inherit' }); if (result.error) { process.stderr.write(result.error.message + '\\n'); process.exitCode = 1; } else { process.exitCode = result.status ?? 1; }`;
  return runNodeCode(cwd, code, winptyPath);
}

test('worktreeAdd passes quiet through to Git while preserving hook output and errors', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-git-worktree-add-'));
  let baselineDestination;
  let terminalDestination;
  let winptyPath = null;
  try {
    git(repo, 'init');
    git(repo, 'config', 'user.name', 'gh-maestro test');
    git(repo, 'config', 'user.email', 'gh-maestro-test@example.invalid');
    fs.writeFileSync(path.join(repo, 'README.md'), 'test\n', 'utf8');
    // Force checkout to have enough tracked files for Git's progress meter to run.
    for (let i = 0; i < 160; i += 1) {
      fs.writeFileSync(path.join(repo, `progress-${i}.txt`), Buffer.alloc(64 * 1024, i % 251));
    }
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'initial');
    const currentBranch = git(repo, 'symbolic-ref', '--short', 'HEAD').stdout.trim();

    if (process.platform === 'win32') {
      winptyPath = findWinpty();
      baselineDestination = path.join(repo, 'baseline-worktree');
      const baseline = runGitWorktreeAdd(repo, baselineDestination, 'progress-output-test', winptyPath);
      const baselineOutput = `${baseline.stdout}\n${baseline.stderr}`;
      assert.equal(baseline.status, 0, baselineOutput);
      assert.match(baselineOutput, /Updating files:/i, 'unsuppressed Git worktree checkout should emit progress in a terminal');
    }

    const hookDir = path.join(repo, 'hooks');
    fs.mkdirSync(hookDir);
    const hookPath = path.join(hookDir, 'post-checkout');
    fs.writeFileSync(hookPath, '#!/bin/sh\nprintf "HOOK_STDOUT\\n"\nprintf "HOOK_STDERR\\n" >&2\nexit 0\n', 'utf8');
    try { fs.chmodSync(hookPath, 0o755); } catch {}
    git(repo, 'config', 'core.hooksPath', hookDir);

    const destination = path.join(repo, 'actual-worktree');
    const success = runWorktreeAdd(repo, destination, 'quiet-output-test');
    const successOutput = `${success.stdout}\n${success.stderr}`;
    assert.equal(success.status, 0, `${success.stdout}\n${success.stderr}`);
    assert.doesNotMatch(successOutput, /Preparing worktree/);
    assert.doesNotMatch(success.stdout, /Updating files:/i);
    assert.doesNotMatch(success.stderr, /Updating files:/i);
    assert.match(success.stdout, /HOOK_STDOUT/);
    assert.match(success.stderr, /HOOK_STDERR/);
    assert.ok(fs.existsSync(path.join(destination, 'README.md')));

    if (winptyPath) {
      terminalDestination = path.join(repo, 'terminal-worktree');
      const terminalSuccess = runWorktreeAdd(repo, terminalDestination, 'quiet-terminal-output-test', winptyPath);
      const terminalOutput = `${terminalSuccess.stdout}\n${terminalSuccess.stderr}`;
      assert.equal(terminalSuccess.status, 0, terminalOutput);
      assert.doesNotMatch(terminalSuccess.stdout, /Updating files:/i);
      assert.doesNotMatch(terminalSuccess.stderr, /Updating files:/i);
      assert.match(terminalOutput, /HOOK_STDOUT/);
      assert.match(terminalOutput, /HOOK_STDERR/);
    }

    const failure = runWorktreeAdd(repo, path.join(repo, 'failed-worktree'), currentBranch);
    assert.equal(failure.status, 7, `${failure.stdout}\n${failure.stderr}`);
    assert.match(failure.stderr, /already exists|already checked out/i);
    assert.match(failure.stderr, /CAUGHT:/);
    assert.doesNotMatch(`${failure.stdout}\n${failure.stderr}`, /Preparing worktree/);
    assert.doesNotMatch(failure.stdout, /Updating files:/i);
    assert.doesNotMatch(failure.stderr, /Updating files:/i);
  } finally {
    if (baselineDestination) {
      try { git(repo, 'worktree', 'remove', '--force', baselineDestination); } catch {}
    }
    if (terminalDestination) {
      try { git(repo, 'worktree', 'remove', '--force', terminalDestination); } catch {}
    }
    try { git(repo, 'worktree', 'remove', '--force', path.join(repo, 'actual-worktree')); } catch {}
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

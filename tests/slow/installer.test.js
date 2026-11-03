'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('../../scripts/shared/child-process');
const { installScripts } = require('../../scripts/install');

const ROOT = path.join(__dirname, '..', '..');

test('installScriptsは隔離git rootのremote・branch・HEADを取得して配布物へ埋め込む', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-install-source-test-'));
  const sourceRoot = path.join(tempRoot, 'source');
  const sharedScripts = path.join(tempRoot, 'installed', 'scripts');
  fs.mkdirSync(sourceRoot, { recursive: true });

  const git = (args) => spawnSync('git', args, { cwd: sourceRoot, encoding: 'utf8' });
  try {
    const init = git(['init', '-q', '-b', 'dev']);
    assert.equal(init.status, 0, `git init failed: ${init.stderr}`);
    const remote = git(['remote', 'add', 'origin', 'https://github.com/fixture/maestro-source']);
    assert.equal(remote.status, 0, `git remote add failed: ${remote.stderr}`);
    const commit = git([
      '-c', 'user.name=Fixture',
      '-c', 'user.email=fixture@example.test',
      'commit', '--allow-empty', '-m', 'fixture source commit',
    ]);
    assert.equal(commit.status, 0, `git commit failed: ${commit.stderr}`);
    const expectedHead = git(['rev-parse', 'HEAD']);
    assert.equal(expectedHead.status, 0, `git rev-parse failed: ${expectedHead.stderr}`);

    installScripts({
      scriptsDir: path.join(ROOT, 'scripts'),
      sharedScripts,
      agentsYaml: path.join(ROOT, 'skills', 'agents.yaml'),
      installRoot: sourceRoot,
      step: () => {},
      ok: () => {},
    });

    const installed = require(path.join(sharedScripts, 'get-context.js'));
    assert.deepEqual(installed.INSTALL_SOURCE, {
      repo: 'fixture/maestro-source',
      branch: 'dev',
      commit: expectedHead.stdout.trim(),
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

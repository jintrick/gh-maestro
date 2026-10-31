'use strict';

// run-tests.js --declared-tests の CLI 境界（slow 層。実プロセスを子として起動する）。
// .claude/rules/cli-input-validation-at-boundary.md: 実際の argv・標準入力・終了コードを確かめる。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const RUN_TESTS_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'run-tests.js');
const REPO_ROOT = path.join(__dirname, '..', '..');

test('CLI境界: --declared-tests は標準入力のパスのうち宣言されたテストファイルだけを出力し、exit 0', () => {
  const result = spawnSync(process.execPath, [RUN_TESTS_SCRIPT, '--workspace', REPO_ROOT, '--declared-tests'], {
    cwd: REPO_ROOT,
    input: 'scripts/x.js\ntests/a.test.js\nsrc/foo.test.js\ntests/slow/b.test.js\n',
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.deepEqual(result.stdout.split('\n').filter(Boolean), ['tests/a.test.js', 'tests/slow/b.test.js']);
});

test('CLI境界: --declared-tests と --list の併用は exit 1 で拒否する', () => {
  const result = spawnSync(process.execPath, [RUN_TESTS_SCRIPT, '--workspace', REPO_ROOT, '--declared-tests', '--list'], {
    cwd: REPO_ROOT,
    input: '',
    encoding: 'utf8',
  });
  assert.equal(result.status, 1, `stderr: ${result.stderr}`);
  assert.match(result.stderr, /併用できません/);
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'skills', 'gh-maestro-orchestrator', 'scripts', 'get-context.js');
const REPO_ROOT = path.join(__dirname, '..');

test('REPO と WORKSPACE を正しいフォーマットで出力する', () => {
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  assert.match(r.stdout, /^REPO='[^/]+\/[^']+'/m);
  assert.match(r.stdout, /^WORKSPACE='[^']+'/m);
});

test('WORKSPACE はカレントディレクトリと一致する', () => {
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0);
  const match = r.stdout.match(/^WORKSPACE='([^']+)'/m);
  assert.ok(match, 'WORKSPACEが出力に含まれない');
  assert.equal(match[1], REPO_ROOT);
});

test('git remote がないディレクトリでは非0終了する', () => {
  const { mkdtempSync, rmdirSync } = require('fs');
  const os = require('os');
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-no-git-'));
  try {
    const r = spawnSync(process.execPath, [SCRIPT], {
      cwd: tmp,
      encoding: 'utf8',
    });
    assert.notEqual(r.status, 0);
  } finally {
    require('fs').rmdirSync(tmp, { recursive: true });
  }
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { main } = require('../../scripts/write-draft');
const { toWinPath } = require('../../scripts/shared/win-path');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'write-draft.js');















test('サブプロセス経由: 引数なしはUsageエラーで終了コード1', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage/);
});

test('サブプロセス経由: --helpは終了コード0', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage/);
});

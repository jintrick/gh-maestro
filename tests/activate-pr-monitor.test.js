'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const script = path.join(__dirname, '..', 'scripts', 'activate-pr-monitor.js');

test('activate-pr-monitor の必須Issue検証はCLI境界で非ゼロ終了する', () => {
  const result = spawnSync(process.execPath, [script, '--workspace', __dirname], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--issue/);
});

test('activate-pr-monitor の未知フラグはCLI境界で拒否する', () => {
  const result = spawnSync(process.execPath, [script, '--issue', '581', '--unknown'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /未知のフラグ/);
});

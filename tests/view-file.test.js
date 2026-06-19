'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'skills', 'gh-maestro-orchestrator', 'scripts', 'view-file.js');

function run(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('ファイルパス引数がないとUsageエラー', () => {
  const r = run([], { WEZTERM_PANE: '1' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage/);
});

test('WEZTERM_PANEが未設定だとエラー終了する', () => {
  const env = { ...process.env };
  delete env.WEZTERM_PANE;
  const r = spawnSync(process.execPath, [SCRIPT, '/tmp/test.md'], {
    encoding: 'utf8',
    env,
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /WEZTERM_PANE/);
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'skills', 'gh-maestro-orchestrator', 'scripts', 'spawn-worker.js');

function run(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

// WEZTERM_PANE がないと即失敗するので、ダミー値をセットして引数バリデーションまで到達させる
const BASE_ENV = { WEZTERM_PANE: '999' };

test('--skill がないとエラー終了する', () => {
  const r = run(['--issue', '1', '--description', 'test', '--repo', 'o/r'], BASE_ENV);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--skill/);
});

test('--issue がないとエラー終了する', () => {
  const r = run(['--skill', 'gh-maestro-coder', '--description', 'test', '--repo', 'o/r'], BASE_ENV);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--issue/);
});

test('--description がないとエラー終了する', () => {
  const r = run(['--skill', 'gh-maestro-coder', '--issue', '1', '--repo', 'o/r'], BASE_ENV);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--description/);
});

test('--repo がないとエラー終了する', () => {
  const r = run(['--skill', 'gh-maestro-coder', '--issue', '1', '--description', 'test'], BASE_ENV);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--repo/);
});

test('gh-maestro-base で --prompt がないとエラー終了する', () => {
  const r = run([
    '--skill', 'gh-maestro-base',
    '--issue', '1', '--description', 'test', '--repo', 'o/r',
  ], BASE_ENV);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--prompt/);
});

test('--prompt にシングルクォートを含めるとエラー終了する', () => {
  const r = run([
    '--skill', 'gh-maestro-coder',
    '--issue', '1', '--description', 'test', '--repo', 'o/r',
    '--prompt', "it's a test",
  ], BASE_ENV);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /シングルクォート/);
});

test('WEZTERM_PANE が未設定だとエラー終了する', () => {
  const envWithoutPane = { ...process.env };
  delete envWithoutPane.WEZTERM_PANE;
  const r = spawnSync(process.execPath, [SCRIPT,
    '--skill', 'gh-maestro-coder',
    '--issue', '1', '--description', 'test', '--repo', 'o/r',
  ], { encoding: 'utf8', env: envWithoutPane });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /WEZTERM_PANE/);
});

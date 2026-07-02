'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'spawn-worker.js');

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

// ── link-node-modules の解決 ──────────────────────────────────────────────────

test('link-node-modules がリポジトリ内パスから解決できる', () => {
  const nm = path.join(__dirname, '..', 'scripts', 'link-node-modules');
  assert.doesNotThrow(() => {
    const resolved = require.resolve(nm);
    assert.ok(resolved.endsWith('link-node-modules.js'));
  });
  const mod = require(nm);
  assert.ok(mod.linkNodeModules);
  assert.equal(typeof mod.linkNodeModules, 'function');
});

test('link-node-modules がインストール先と同構造のディレクトリから解決できる', () => {
  const tmpdir = require('os').tmpdir();
  const { mkdtempSync, copyFileSync } = require('fs');
  const { rmSync } = require('fs');
  const tmp = mkdtempSync(path.join(tmpdir, 'gh-maestro-test-linknm-'));
  try {
    const srcNm = path.join(__dirname, '..', 'scripts', 'link-node-modules.js');
    const destNm = path.join(tmp, 'link-node-modules.js');
    copyFileSync(srcNm, destNm);

    // 別のプロセスで require してキャッシュの影響を排除
    const verify = spawnSync(process.execPath, ['-e', `
      const mod = require(${JSON.stringify(destNm)});
      if (typeof mod.linkNodeModules !== 'function') process.exit(1);
      console.log('OK');
    `], { encoding: 'utf8' });
    assert.equal(verify.status, 0);
    assert.match(verify.stdout, /^OK/m);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── agent 解決 ────────────────────────────────────────────────────────────────

test('--agent で存在しないエージェントを指定した場合はエラー終了する', () => {
  const fs = require('fs');
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-agent-'));
  try {
    fs.mkdirSync(path.join(tmp, '.gh-maestro'), { recursive: true });
    // agents.json を意図的に作らない → エージェント未定義

    const r = spawnSync(process.execPath, [SCRIPT,
      '--skill', 'gh-maestro-coder',
      '--issue', '1', '--description', 'test', '--repo', 'o/r',
      '--agent', 'nonexistent',
    ], {
      encoding: 'utf8',
      env: { ...process.env, WEZTERM_PANE: '999', HOME: tmp },
    });

    assert.notEqual(r.status, 0, 'exit code should be non-zero');
    assert.match(r.stderr, /nonexistent/, 'error should name the missing agent');
    assert.match(r.stderr, /agents\.json/, 'error should reference agents.json');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('agents.json に定義されていてもバイナリが PATH になければエラー終了する', () => {
  const fs = require('fs');
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-bin-'));
  try {
    fs.mkdirSync(path.join(tmp, '.gh-maestro'), { recursive: true });
    // バイナリが存在しないコマンドを持つエージェントを定義
    fs.writeFileSync(
      path.join(tmp, '.gh-maestro', 'agents.json'),
      JSON.stringify([
        { id: 'fake', label: 'Fake CLI', command: 'nonexistent-cmd-xyz', extraArgs: [], promptFlag: null },
      ]),
    );

    const r = spawnSync(process.execPath, [SCRIPT,
      '--skill', 'gh-maestro-coder',
      '--issue', '1', '--description', 'test', '--repo', 'o/r',
      '--agent', 'fake',
    ], {
      encoding: 'utf8',
      env: { ...process.env, WEZTERM_PANE: '999', HOME: tmp },
    });

    assert.notEqual(r.status, 0, 'exit code should be non-zero');
    assert.match(r.stderr, /PATH に見つかりません/, 'error should be about missing binary');
    assert.match(r.stderr, /nonexistent-cmd-xyz/, 'error should name the missing command');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

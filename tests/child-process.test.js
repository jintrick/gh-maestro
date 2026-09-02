'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const WRAPPER_PATH = require.resolve('../scripts/shared/child-process');

/**
 * child_process の基底APIを安全なフェイクへ差し替えて共有ラッパーを再読込する。
 * ガードが無ければフェイクが呼ばれるため、実行ファイルを実際に起動せずに
 * 「拒否が委譲より前にあること」も検証できる。
 */
function loadWrapperWithFakeChildProcess() {
  const originalLoad = Module._load;
  const previousCacheEntry = require.cache[WRAPPER_PATH];
  const calls = [];
  const fakeChildProcess = {
    spawn(...args) {
      calls.push({ method: 'spawn', args });
      return { pid: 1 };
    },
    spawnSync(...args) {
      calls.push({ method: 'spawnSync', args });
      return { status: 0, stdout: 'fake-output', stderr: '' };
    },
    execSync(...args) {
      calls.push({ method: 'execSync', args });
      return 'fake-output';
    },
  };

  delete require.cache[WRAPPER_PATH];
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'child_process') return fakeChildProcess;
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return { wrapper: require(WRAPPER_PATH), calls };
  } finally {
    Module._load = originalLoad;
    delete require.cache[WRAPPER_PATH];
    if (previousCacheEntry) require.cache[WRAPPER_PATH] = previousCacheEntry;
  }
}

function assertBlocked(action, code) {
  assert.throws(action, (error) => {
    assert.equal(error.code, code);
    assert.match(error.message, /WezTermを起動しません/);
    return true;
  });
}

test('child-process: テスト中の wezterm 起動を全ての共有APIで委譲前に拒否する', () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, '前提: テストランナー配下で実行されている');
  const { wrapper, calls } = loadWrapperWithFakeChildProcess();

  assertBlocked(
    () => wrapper.spawn('wezterm', ['--version']),
    wrapper.REAL_SPAWN_DISABLED_ERROR_CODE,
  );
  assertBlocked(
    () => wrapper.spawnSync('C:\\Program Files\\WezTerm\\wezterm.exe', ['--version']),
    wrapper.REAL_SPAWN_DISABLED_ERROR_CODE,
  );
  assertBlocked(
    () => wrapper.execSync('"wezterm.cmd" --version'),
    wrapper.REAL_SPAWN_DISABLED_ERROR_CODE,
  );

  assert.equal(calls.length, 0, '拒否時に基底 child_process API を呼ばないこと');
});

test('child-process: NODE_TEST_CONTEXT が無い本番相当の環境では wezterm を拒否しない', () => {
  const savedContext = process.env.NODE_TEST_CONTEXT;
  const savedDisabled = process.env.GH_MAESTRO_DISABLE_REAL_SPAWN;
  delete process.env.NODE_TEST_CONTEXT;
  delete process.env.GH_MAESTRO_DISABLE_REAL_SPAWN;
  try {
    const { wrapper, calls } = loadWrapperWithFakeChildProcess();
    const result = wrapper.spawnSync('wezterm', ['--version']);
    assert.equal(result.status, 0);
    assert.equal(calls.length, 1, '本番相当の環境では基底APIへ委譲すること');
  } finally {
    if (savedContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = savedContext;
    if (savedDisabled === undefined) delete process.env.GH_MAESTRO_DISABLE_REAL_SPAWN;
    else process.env.GH_MAESTRO_DISABLE_REAL_SPAWN = savedDisabled;
  }
});

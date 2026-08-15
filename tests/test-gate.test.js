'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// scripts/shared/test-gate.js（Issue #209）を検証する。
// child-process.js の spawnSync をモックし、実 `npm test` は実行しない（実プロセス 0 個）。
// # fail 集計行のパースと、GIT_* 除去を伴う spawn 引数組み立てを検証する。

const testGatePath = require.resolve('../scripts/shared/test-gate');

/**
 * child-process.js の spawnSync をモックした状態で test-gate.js を再ロードする。
 * @param {Function} [spawnSyncImpl] (cmd, args, opts) => result
 */
function loadModule(spawnSyncImpl) {
  const calls = [];
  const fakeSpawnSync = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return spawnSyncImpl ? spawnSyncImpl(cmd, args, opts) : { status: 0, stdout: '' };
  };

  const childProcessPath = require.resolve('../scripts/child-process');
  delete require.cache[childProcessPath];
  require.cache[childProcessPath] = {
    id: childProcessPath,
    filename: childProcessPath,
    loaded: true,
    exports: {
      spawn: () => { throw new Error('spawn should not be called in this test'); },
      spawnSync: fakeSpawnSync,
      execSync: () => '',
      // 本番実装の stripGitEnv と同義（GIT_* を除去）。runTestSuite が spawn 前にこれを
      // 通した env を子プロセスへ渡すことを検証する（Issue #283/#209）。
      stripGitEnv: (o) => {
        const src = o && o.env ? o.env : process.env;
        const env = { ...src };
        for (const key of Object.keys(env)) {
          if (key.startsWith('GIT_')) delete env[key];
        }
        return env;
      },
    },
  };

  delete require.cache[testGatePath];
  const mod = require(testGatePath);

  delete require.cache[childProcessPath];
  return { mod, calls };
}

test('runTestSuite: # fail 0 を fail=0 として読む（npm test を実行する）', () => {
  const { mod, calls } = loadModule(() => ({ status: 0, stdout: '# tests 5\n# pass 5\n# fail 0\n' }));
  const r = mod.runTestSuite({ cwd: '/tmp/repo' });
  assert.equal(r.status, 0);
  assert.equal(r.fail, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['test'], 'npm test の test 引数で呼ぶ');
});

test('runTestSuite: # fail 2 と status を読む（失敗検出）', () => {
  const { mod } = loadModule(() => ({ status: 1, stdout: '# tests 3\n# pass 1\n# fail 2\n' }));
  const r = mod.runTestSuite({ cwd: '/tmp/repo' });
  assert.equal(r.fail, 2);
  assert.equal(r.status, 1);
});

test('runTestSuite: # fail 集計行が無ければ fail=null（フェイルクローズの判定材料）', () => {
  const { mod } = loadModule(() => ({ status: 0, stdout: 'unexpected output\n' }));
  const r = mod.runTestSuite({ cwd: '/tmp/repo' });
  assert.equal(r.fail, null);
  assert.equal(r.status, 0);
});

test('runTestSuite: 集計行が stderr にあっても読む（stdout と結合して判定）', () => {
  const { mod } = loadModule(() => ({ status: 1, stdout: '', stderr: '# tests 1\n# pass 0\n# fail 1\n' }));
  const r = mod.runTestSuite({ cwd: '/tmp/repo' });
  assert.equal(r.fail, 1);
});

test('runTestSuite: spawn に渡す env から GIT_* を除去し、cwd を指定する（Issue #283/#209）', () => {
  const { mod, calls } = loadModule(() => ({ status: 0, stdout: '# fail 0\n' }));
  const r = mod.runTestSuite({ cwd: '/tmp/repo', env: { GIT_DIR: '/fake/repo', GIT_WORK_TREE: '/fake/wt', PATH: '/bin', HOME: '/h' } });
  assert.equal(r.fail, 0);
  const spawnOpts = calls[0].opts;
  assert.equal(spawnOpts.env.GIT_DIR, undefined, 'GIT_DIR を除去する');
  assert.equal(spawnOpts.env.GIT_WORK_TREE, undefined, 'GIT_WORK_TREE を除去する');
  assert.equal(spawnOpts.env.PATH, '/bin', 'GIT_* 以外は残す');
  assert.equal(spawnOpts.cwd, '/tmp/repo');
});

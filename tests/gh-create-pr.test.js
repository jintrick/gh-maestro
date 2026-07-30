'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// gh-create-pr.js は require.main===module 時のみCLIを実行するため、
// resolveBaseBranch/createPr は純粋関数としてrequireで検証する。
// child-process.js の spawnSync をモックし、実プロセスを0個spawnする
// （.claude/rules/test-process-spawn-safety.md 準拠）。

const ghCreatePrPath = require.resolve('../scripts/gh-create-pr');

/**
 * scripts/child-process.js の spawnSync をモックした状態で gh-create-pr.js を再ロードする。
 * @param {Function} spawnSyncImpl (cmd, args, opts) => result
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
    },
  };

  delete require.cache[ghCreatePrPath];
  const mod = require(ghCreatePrPath);

  delete require.cache[childProcessPath];
  return { mod, calls };
}

// ── resolveBaseBranch ───────────────────────────────────────────────────────

test('resolveBaseBranch: origin/dev から dev を解決する', () => {
  const { mod, calls } = loadModule(() => ({ status: 0, stdout: 'origin/dev\n' }));
  const branch = mod.resolveBaseBranch();
  assert.equal(branch, 'dev');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'git');
  assert.deepEqual(calls[0].args, ['rev-parse', '--abbrev-ref', '@{upstream}']);
});

test('resolveBaseBranch: origin/main から main を解決する', () => {
  const { mod, calls } = loadModule(() => ({ status: 0, stdout: 'origin/main\n' }));
  const branch = mod.resolveBaseBranch();
  assert.equal(branch, 'main');
  assert.equal(calls.length, 1);
});

test('resolveBaseBranch: upstream未設定でエラー', () => {
  const { mod } = loadModule(() => ({ status: 128, stdout: '', stderr: 'fatal: ...' }));
  assert.throws(() => mod.resolveBaseBranch(), {
    message: /upstream trackingが設定されていません/,
  });
});

test('resolveBaseBranch: origin/ 以外の形式でエラー', () => {
  const { mod } = loadModule(() => ({ status: 0, stdout: 'upstream/dev\n' }));
  assert.throws(() => mod.resolveBaseBranch(), {
    message: /予期しないupstream形式/,
  });
});

test('resolveBaseBranch: gitエラー（r.error）でエラー', () => {
  const { mod } = loadModule(() => ({ error: new Error('ENOENT') }));
  assert.throws(() => mod.resolveBaseBranch(), {
    message: /upstream trackingが設定されていません/,
  });
});

// ── createPr ─────────────────────────────────────────────────────────────────

test('createPr: 正しい引数で gh pr create を呼ぶ', () => {
  let callIndex = 0;
  const { mod, calls } = loadModule((cmd, args) => {
    if (callIndex === 0) {
      // 1回目: git rev-parse (resolveBaseBranch)
      callIndex++;
      return { status: 0, stdout: 'origin/dev\n' };
    }
    // 2回目: gh pr create
    return { status: 0, stdout: 'https://github.com/owner/repo/pull/123\n' };
  });
  const result = mod.createPr({ title: 'Fix bug', body: 'Closes #1' });
  assert.equal(result.url, 'https://github.com/owner/repo/pull/123');
  assert.equal(result.status, 0);

  // 最後の呼び出しが gh pr create であることを確認
  const ghCall = calls.find(c => c.cmd === 'gh');
  assert.ok(ghCall, 'gh should be called');
  assert.equal(ghCall.args[0], 'pr');
  assert.equal(ghCall.args[1], 'create');
  assert.equal(ghCall.args[2], '--base');
  assert.equal(ghCall.args[3], 'dev');
  assert.equal(ghCall.args[4], '--title');
  assert.equal(ghCall.args[5], 'Fix bug');
  assert.equal(ghCall.args[6], '--body');
  assert.equal(ghCall.args[7], 'Closes #1');
});

test('createPr: --repo が指定された場合に渡される', () => {
  let callIndex = 0;
  const { mod, calls } = loadModule(() => {
    if (callIndex++ === 0) return { status: 0, stdout: 'origin/dev\n' };
    return { status: 0, stdout: 'https://github.com/owner/repo/pull/456\n' };
  });
  mod.createPr({ title: 'Fix', body: 'Closes #1', repo: 'custom/repo' });
  const ghCall = calls.find(c => c.cmd === 'gh');
  assert.ok(ghCall.args.includes('--repo'));
  assert.ok(ghCall.args.includes('custom/repo'));
});

test('createPr: gh 失敗時に status と stderr を返す', () => {
  let callIndex = 0;
  const { mod } = loadModule(() => {
    if (callIndex++ === 0) return { status: 0, stdout: 'origin/dev\n' };
    return { status: 1, stdout: '', stderr: 'gh: error: ...' };
  });
  const result = mod.createPr({ title: 'Fix', body: 'Closes #1' });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'gh: error: ...');
});

test('createPr: bodyFile が指定された場合に --body-file で渡される', () => {
  let callIndex = 0;
  const { mod, calls } = loadModule(() => {
    if (callIndex++ === 0) return { status: 0, stdout: 'origin/dev\n' };
    return { status: 0, stdout: 'https://github.com/owner/repo/pull/789\n' };
  });
  mod.createPr({ title: 'Fix', bodyFile: '/tmp/body.md' });
  const ghCall = calls.find(c => c.cmd === 'gh');
  assert.ok(ghCall.args.includes('--body-file'));
  assert.ok(ghCall.args.includes('/tmp/body.md'));
  assert.ok(!ghCall.args.includes('--body'));
});

// ── main（CLIエントリポイント） ──────────────────────────────────────────────

test('main: --help を表示する', () => {
  const { mod } = loadModule();
  const result = mod.main(['--help']);
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.includes('Usage'));
});

test('main: -h を表示する', () => {
  const { mod } = loadModule();
  const result = mod.main(['-h']);
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.includes('Usage'));
});

test('main: --title なしでエラー', () => {
  const { mod } = loadModule();
  const result = mod.main(['--body', 'hello']);
  assert.equal(result.exitCode, 1);
  assert.ok(result.stderr.includes('--title'));
});

test('main: --body なしでエラー', () => {
  const { mod } = loadModule();
  const result = mod.main(['--title', 'hello']);
  assert.equal(result.exitCode, 1);
  assert.ok(result.stderr.includes('--body'));
});

test('main: --body と --body-file の同時指定でエラー', () => {
  const { mod } = loadModule();
  const result = mod.main(['--title', 'hello', '--body', 'body', '--body-file', '/tmp/body.md']);
  assert.equal(result.exitCode, 1);
  assert.ok(result.stderr.includes('同時'));
});

test('main: 未知の引数でエラー', () => {
  const { mod } = loadModule();
  const result = mod.main(['--title', 'hello', '--body', 'world', '--unknown']);
  assert.equal(result.exitCode, 1);
  assert.ok(result.stderr.includes('未知の引数'));
});

test('main: 正常系でURLを出力する', () => {
  let callIndex = 0;
  const { mod } = loadModule(() => {
    if (callIndex++ === 0) return { status: 0, stdout: 'origin/dev\n' };
    return { status: 0, stdout: 'https://github.com/owner/repo/pull/123\n' };
  });
  const result = mod.main(['--title', 'Fix bug', '--body', 'Closes #1']);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'https://github.com/owner/repo/pull/123');
});

test('main: gh 失敗時はエラー終了', () => {
  let callIndex = 0;
  const { mod } = loadModule(() => {
    if (callIndex++ === 0) return { status: 0, stdout: 'origin/dev\n' };
    return { status: 1, stdout: '', stderr: 'gh error details' };
  });
  const result = mod.main(['--title', 'Fix', '--body', 'Closes #1']);
  assert.equal(result.exitCode, 1);
  assert.ok(result.stderr.includes('gh pr create 失敗'));
});

test('main: resolveBaseBranch のエラーをキャッチする', () => {
  const { mod } = loadModule(() => ({ status: 128, stdout: '' }));
  const result = mod.main(['--title', 'Fix', '--body', 'Closes #1']);
  assert.equal(result.exitCode, 1);
  assert.ok(result.stderr.includes('upstream tracking'));
});

test('main: --value フラグで値不足の場合にエラー', () => {
  const { mod } = loadModule();
  const result = mod.main(['--title']);
  assert.equal(result.exitCode, 1);
});

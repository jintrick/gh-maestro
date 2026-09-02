'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// git-worktree.js は child-process.js の spawnSync に依存するため、
// これをモックして実プロセスを0個spawnする。
//

const gitWorktreePath = require.resolve('../scripts/shared/git-worktree');

/**
 * scripts/shared/child-process.js の spawnSync をモックした状態で git-worktree.js を再ロードする。
 * @param {Function} spawnSyncImpl (cmd, args, opts) => result - 呼び出し順に応じた戻り値を返す
 */
function loadModule(spawnSyncImpl) {
  const calls = [];
  let callIndex = 0;
  const fakeSpawnSync = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const impl = spawnSyncImpl ? spawnSyncImpl(cmd, args, opts, callIndex) : { status: 0, stdout: '' };
    callIndex++;
    return impl;
  };

  const childProcessPath = require.resolve('../scripts/shared/child-process');
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

  delete require.cache[gitWorktreePath];
  const mod = require(gitWorktreePath);

  delete require.cache[childProcessPath];
  return { mod, calls };
}

// ── worktreeAdd ───────────────────────────────────────────────────────────────

test('worktreeAdd: baseRefあり — worktree add後に --set-upstream-to を呼ぶ', () => {
  const { mod, calls } = loadModule(() => ({ status: 0, stdout: '' }));
  mod.worktreeAdd('/tmp/wt', 'feat-x', 'dev', '/repo');

  // 1回目: git worktree add
  assert.equal(calls[0].cmd, 'git');
  assert.ok(calls[0].args.includes('worktree'));
  assert.ok(calls[0].args.includes('add'));
  assert.ok(calls[0].args.includes('/tmp/wt'));
  assert.ok(calls[0].args.includes('-b'));
  assert.ok(calls[0].args.includes('feat-x'));
  assert.ok(calls[0].args.includes('origin/dev'));

  // 2回目: git branch --set-upstream-to
  assert.equal(calls[1].cmd, 'git');
  assert.ok(calls[1].args.includes('branch'));
  assert.ok(calls[1].args.includes('--set-upstream-to'));
  assert.ok(calls[1].args.includes('origin/dev'));
  assert.ok(calls[1].args.includes('--'));
  assert.ok(calls[1].args.includes('feat-x'));
});

test('worktreeAdd: baseRefなし — --set-upstream-to を呼ばない', () => {
  const { mod, calls } = loadModule(() => ({ status: 0, stdout: '' }));
  mod.worktreeAdd('/tmp/wt', 'feat-x', null, '/repo');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'git');
  assert.ok(calls[0].args.includes('worktree'));
  assert.ok(calls[0].args.includes('add'));
});

test('worktreeAdd: worktree add 失敗時は --set-upstream-to を呼ばずに throw', () => {
  let callCount = 0;
  const { mod, calls } = loadModule((cmd, args) => {
    callCount++;
    if (args.includes('worktree') && args.includes('add')) {
      return { status: 128, stderr: 'fatal: ...' };
    }
    return { status: 0, stdout: '' };
  });

  assert.throws(() => mod.worktreeAdd('/tmp/wt', 'feat-x', 'dev', '/repo'), {
    message: /exited with 128/,
  });

  // worktree addだけが呼ばれ、--set-upstream-to は呼ばれていない
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes('worktree'));
  assert.ok(calls[0].args.includes('add'));
});

// ── 回帰テスト: branch.autoSetupMerge が false でも upstream tracking が設定される ──
// このテストはモックレベルで「worktree add 後に必ず --set-upstream-to が呼ばれる」
// ことを検証する。実際の autoSetupMerge=false 環境での動作は git-worktree.js の
// ロジックそのものに依存せず、モック呼び出し順で担保する。

test('worktreeAdd: baseRefありの場合の呼び出し順 — worktree add → set-upstream-to', () => {
  const { mod, calls } = loadModule(() => ({ status: 0, stdout: '' }));
  mod.worktreeAdd('/tmp/wt', 'feat-x', 'dev', '/repo');

  assert.equal(calls.length, 2);
  // 1回目: worktree add
  assert.ok(calls[0].args.includes('worktree'));
  assert.ok(calls[0].args.includes('add'));
  // 2回目: --set-upstream-to
  assert.ok(calls[1].args.includes('branch'));
  assert.ok(calls[1].args.includes('--set-upstream-to'));
});

// ── エクスポート確認 ──────────────────────────────────────────────────────────

test('git-worktree: setUpstream はエクスポートされていない', () => {
  // setUpstream は内部関数のため、module.exports に含まれていない
  // ここでは worktreeAdd/worktreeRemove/worktreePrune だけが公開されていることを確認
  const { mod } = loadModule(() => ({ status: 0, stdout: '' }));
  assert.equal(typeof mod.worktreeAdd, 'function');
  assert.equal(typeof mod.worktreeRemove, 'function');
  assert.equal(typeof mod.worktreePrune, 'function');
  assert.equal(mod.setUpstream, undefined);
});

// ── worktreeAddDetached ─────────────────────────────────────────────────────────

const SHA = '0123456789abcdef0123456789abcdef01234567'; // 40桁の16進数

test('worktreeAddDetached: --detach と sha を -- 区切りで渡す', () => {
  const { mod, calls } = loadModule(() => ({ status: 0, stdout: '' }));
  mod.worktreeAddDetached('/tmp/wt', SHA, '/repo');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'git');
  assert.ok(calls[0].args.includes('worktree'));
  assert.ok(calls[0].args.includes('add'));
  assert.ok(calls[0].args.includes('--detach'));
  assert.ok(calls[0].args.includes('/tmp/wt'));
  // sha は -- セパレータの後（git-arg-injection ルール: '-' 始まりの値がオプション化しない）
  const dashIdx = calls[0].args.indexOf('--');
  assert.ok(dashIdx >= 0);
  assert.equal(calls[0].args[dashIdx + 1], SHA);
});

test('worktreeAddDetached: git が失敗したら throw', () => {
  const { mod } = loadModule(() => ({ status: 128, stderr: 'fatal: ...' }));
  assert.throws(
    () => mod.worktreeAddDetached('/tmp/wt', SHA, '/repo'),
    { message: /exited with 128/ },
  );
});

test('git-worktree: worktreeAddDetached がエクスポートされている', () => {
  const { mod } = loadModule(() => ({ status: 0, stdout: '' }));
  assert.equal(typeof mod.worktreeAddDetached, 'function');
});

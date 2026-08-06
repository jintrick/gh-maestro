'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// git を伴う関数（ensureCouncilWorktree / removeCouncilWorktree / resolveWorkspaceHead）は
// child-process.js の spawnSync をモックして実プロセスを0個spawnする
// （.claude/rules/test-process-spawn-safety.md 準拠）。
const councilWorktreePath = require.resolve('../scripts/shared/council-worktree');

/**
 * child-process.js の spawnSync をモックした状態で council-worktree.js を再ロードする。
 * @param {Function} spawnSyncImpl (cmd, args, opts, callIndex) => result
 * @returns {{ mod, calls }}
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

  const gitWorktreePath = require.resolve('../scripts/git-worktree');
  delete require.cache[gitWorktreePath];
  delete require.cache[councilWorktreePath];
  const mod = require(councilWorktreePath);

  delete require.cache[childProcessPath];
  return { mod, calls };
}

/** 一時ワークスペースを作り、後始末する。 */
function withTempWorkspace(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-council-wt-test-'));
  try {
    fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const SHA = '0123456789abcdef0123456789abcdef01234567'; // 40桁の16進数

// ── slugifyTitle / assertValidSession ──────────────────────────────────────────

test('slugifyTitle: ASCII英数字は小文字化して残す', () => {
  const { mod } = loadModule();
  assert.equal(mod.slugifyTitle('RAG構成の採用可否'), 'rag');
  // 非ASCII文字は '-' に畳み込まれ、両端の '-' は除去される
  assert.equal(mod.slugifyTitle('Feature Flag 導入'), 'feature-flag');
  assert.equal(mod.slugifyTitle(' v1.2 (beta) '), 'v1-2-beta');
});

test('slugifyTitle: 非ASCIIのみのタイトルは council にフォールバック', () => {
  const { mod } = loadModule();
  assert.equal(mod.slugifyTitle('採用可否について'), 'council');
  assert.equal(mod.slugifyTitle('!!!'), 'council');
});

test('assertValidSession: 妥当な形式は通す', () => {
  const { mod } = loadModule();
  assert.equal(mod.assertValidSession('rag-2'), 'rag-2');
  assert.equal(mod.assertValidSession('ABC_123'), 'ABC_123');
});

test('assertValidSession: 形式外は throw', () => {
  const { mod } = loadModule();
  assert.throws(() => mod.assertValidSession('../..'), /invalid session/);
  assert.throws(() => mod.assertValidSession('foo/bar'), /invalid session/);
  assert.throws(() => mod.assertValidSession('foo bar'), /invalid session/);
  assert.throws(() => mod.assertValidSession('x'.repeat(65)), /invalid session/);
  assert.throws(() => mod.assertValidSession(undefined), /invalid session/);
});

// ── パス導出と封じ込め ────────────────────────────────────────────────────────

test('councilStatePath: <workspace>/.gh-maestro/council-<session>.json を返す', () => {
  const { mod } = loadModule();
  withTempWorkspace(ws => {
    const p = mod.councilStatePath(ws, 's1');
    assert.equal(p, path.join(ws, '.gh-maestro', 'council-s1.json'));
  });
});

test('councilWorktreeDir: <workspace>/.gh-maestro/council-wt-<session>/ を返す', () => {
  const { mod } = loadModule();
  withTempWorkspace(ws => {
    const p = mod.councilWorktreeDir(ws, 's1');
    assert.equal(p, path.join(ws, '.gh-maestro', 'council-wt-s1'));
  });
});

test('councilInvestigationPath: <workspace>/.gh-maestro/council-<session>.investigation.json を返す', () => {
  const { mod } = loadModule();
  withTempWorkspace(ws => {
    const p = mod.councilInvestigationPath(ws, 's1');
    assert.equal(p, path.join(ws, '.gh-maestro', 'council-s1.investigation.json'));
  });
});

test('パス導出: 不正な session は throw（path traversal 遮断）', () => {
  const { mod } = loadModule();
  withTempWorkspace(ws => {
    assert.throws(() => mod.councilStatePath(ws, '../evil'), /invalid session/);
    assert.throws(() => mod.councilWorktreeDir(ws, 'a/b'), /invalid session/);
    assert.throws(() => mod.councilInvestigationPath(ws, '..'), /invalid session/);
  });
});

// ── resolveSession ─────────────────────────────────────────────────────────────

test('resolveSession: 明示 session は形式検証してそのまま返す', () => {
  const { mod } = loadModule();
  withTempWorkspace(ws => {
    assert.equal(mod.resolveSession({ session: 'rag', title: '何でも', workspace: ws }), 'rag');
  });
});

test('resolveSession: 明示 session が形式外なら throw', () => {
  const { mod } = loadModule();
  withTempWorkspace(ws => {
    assert.throws(() => mod.resolveSession({ session: '../x', title: 't', workspace: ws }), /invalid session/);
  });
});

test('resolveSession: session 省略時は title から自動生成する', () => {
  const { mod } = loadModule();
  withTempWorkspace(ws => {
    assert.equal(mod.resolveSession({ title: 'RAG構成の採用可否', workspace: ws }), 'rag');
  });
});

test('resolveSession: state ファイル既存時は -2, -3... の接尾辞を付与する', () => {
  const { mod } = loadModule();
  withTempWorkspace(ws => {
    // council-rag.json と council-rag-2.json が既にある場合 → rag-3
    fs.writeFileSync(path.join(ws, '.gh-maestro', 'council-rag.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(ws, '.gh-maestro', 'council-rag-2.json'), '{}', 'utf8');
    assert.equal(mod.resolveSession({ title: 'RAG構成の採用可否', workspace: ws }), 'rag-3');
  });
});

test('resolveSession: state ファイルが無ければ接尾辞を付けない', () => {
  const { mod } = loadModule();
  withTempWorkspace(ws => {
    fs.writeFileSync(path.join(ws, '.gh-maestro', 'council-other.json'), '{}', 'utf8');
    assert.equal(mod.resolveSession({ title: 'RAG構成の採用可否', workspace: ws }), 'rag');
  });
});

// ── resolveWorkspaceHead ───────────────────────────────────────────────────────

test('resolveWorkspaceHead: 40桁の sha を返す', () => {
  const { mod, calls } = loadModule(() => ({ status: 0, stdout: SHA + '\n', stderr: '' }));
  assert.equal(mod.resolveWorkspaceHead('/repo'), SHA);
  assert.equal(calls[0].cmd, 'git');
  assert.deepEqual(calls[0].args, ['rev-parse', 'HEAD']);
});

test('resolveWorkspaceHead: 異常な stdout は throw', () => {
  const { mod } = loadModule(() => ({ status: 0, stdout: 'not-a-sha', stderr: '' }));
  assert.throws(() => mod.resolveWorkspaceHead('/repo'), /unexpected value/);
});

test('resolveWorkspaceHead: git 失敗は throw', () => {
  const { mod } = loadModule(() => ({ status: 128, stdout: '', stderr: 'fatal: not a git repository' }));
  assert.throws(() => mod.resolveWorkspaceHead('/repo'), /git rev-parse HEAD failed/);
});

// ── ensureCouncilWorktree ──────────────────────────────────────────────────────

test('ensureCouncilWorktree: 未確保なら git worktree add --detach を呼ぶ', () => {
  const { mod, calls } = loadModule(() => ({ status: 0, stdout: '' }));
  withTempWorkspace(ws => {
    const dir = mod.ensureCouncilWorktree(ws, 's1', SHA);
    assert.equal(dir, path.join(ws, '.gh-maestro', 'council-wt-s1'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'git');
    assert.ok(calls[0].args.includes('worktree'));
    assert.ok(calls[0].args.includes('add'));
    assert.ok(calls[0].args.includes('--detach'));
    assert.ok(calls[0].args.includes(SHA));
  });
});

test('ensureCouncilWorktree: 既存worktreeは再利用し git を呼ばない（冪等）', () => {
  const { mod, calls } = loadModule(() => ({ status: 0, stdout: '' }));
  withTempWorkspace(ws => {
    const dir = path.join(ws, '.gh-maestro', 'council-wt-s1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.git'), 'gitdir: ...', 'utf8');
    assert.equal(mod.ensureCouncilWorktree(ws, 's1', SHA), dir);
    assert.equal(calls.length, 0);
  });
});

// ── removeCouncilWorktree ──────────────────────────────────────────────────────

test('removeCouncilWorktree: 存在すれば git worktree remove --force を呼ぶ', () => {
  const { mod, calls } = loadModule(() => ({ status: 0, stdout: '' }));
  withTempWorkspace(ws => {
    const dir = path.join(ws, '.gh-maestro', 'council-wt-s1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.git'), 'gitdir: ...', 'utf8');
    mod.removeCouncilWorktree(ws, 's1');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'git');
    assert.ok(calls[0].args.includes('worktree'));
    assert.ok(calls[0].args.includes('remove'));
    assert.ok(calls[0].args.includes('--force'));
  });
});

test('removeCouncilWorktree: 存在しなければ何もしない（冪等）', () => {
  const { mod, calls } = loadModule(() => ({ status: 0, stdout: '' }));
  withTempWorkspace(ws => {
    mod.removeCouncilWorktree(ws, 's1');
    assert.equal(calls.length, 0);
  });
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// git を伴う関数（ensureCouncilWorktree / removeCouncilWorktree / resolveWorkspaceHead）は
// child-process.js の spawnSync をモックして実プロセスを0個spawnする
//
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

  const gitWorktreePath = require.resolve('../scripts/shared/git-worktree');
  const gitHeadPath = require.resolve('../scripts/shared/git-head');
  delete require.cache[gitWorktreePath];
  delete require.cache[gitHeadPath];
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

test('slugifyTitle: ASCII英数字は小文字化して残し、決定論的ハッシュ接尾辞を付与する', () => {
  const { mod } = loadModule();
  // 非ASCII文字は '-' に畳み込まれ、両端の '-' は除去される。末尾は sha1 先頭8文字
  assert.match(mod.slugifyTitle('RAG構成の採用可否'), /^rag-[0-9a-f]{8}$/);
  assert.match(mod.slugifyTitle('Feature Flag 導入'), /^feature-flag-[0-9a-f]{8}$/);
  assert.match(mod.slugifyTitle(' v1.2 (beta) '), /^v1-2-beta-[0-9a-f]{8}$/);
  // 決定論的（同一タイトル → 同一スラッグ。--resume の安定性）
  assert.equal(mod.slugifyTitle('RAG構成の採用可否'), mod.slugifyTitle('RAG構成の採用可否'));
});

test('slugifyTitle: 非ASCIIのみのタイトルは council ベースでもハッシュで一意化される', () => {
  const { mod } = loadModule();
  assert.match(mod.slugifyTitle('採用可否について'), /^council-[0-9a-f]{8}$/);
  assert.match(mod.slugifyTitle('!!!'), /^council-[0-9a-f]{8}$/);
  // 異なる日本語タイトルが同じ 'council' に潰れない（review指摘 #2 の核心）
  assert.notEqual(mod.slugifyTitle('採用可否について'), mod.slugifyTitle('料金改定について'));
});

test('slugifyTitle: NFKC で全角英字を ASCII へ正規化し、半角版と同一スラッグになる', () => {
  const { mod } = loadModule();
  // 全角英字「ＲＡＧ」は NFKC で「RAG」に正規化される
  assert.match(mod.slugifyTitle('ＲＡＧ構成の採用可否'), /^rag-[0-9a-f]{8}$/);
  // 同一内容の表現差は同一スラッグ（--resume の安定性が表現揺れに左右されない）
  assert.equal(mod.slugifyTitle('ＲＡＧ構成の採用可否'), mod.slugifyTitle('RAG構成の採用可否'));
});

test('slugifyTitle: 純日本語・ひらがな・カタカナのタイトル群は互いに異なるスラッグ（ASCII畳み込み後もハッシュで区別）', () => {
  const { mod } = loadModule();
  const titles = ['採用可否について', 'ひらがなのみ', 'カタカナのみ'];
  const slugs = titles.map(t => mod.slugifyTitle(t));
  // いずれも ASCII ベースは 'council'（日本語が全て畳み込まれる）だが、ハッシュで一意化される
  for (const s of slugs) assert.match(s, /^council-[0-9a-f]{8}$/);
  assert.equal(new Set(slugs).size, slugs.length, `slugs collide: ${slugs.join(', ')}`);
});

test('slugifyTitle: 末尾1文字だけ異なる日本語タイトルは別スラッグ', () => {
  const { mod } = loadModule();
  // ASCII ベースは 'a' / 'b' に別れ、ハッシュでも区別される
  assert.notEqual(mod.slugifyTitle('議題A'), mod.slugifyTitle('議題B'));
  assert.match(mod.slugifyTitle('議題A'), /^a-[0-9a-f]{8}$/);
  assert.match(mod.slugifyTitle('議題B'), /^b-[0-9a-f]{8}$/);
});

test('slugifyTitle: 長いタイトルは SESSION_RE（最大64文字）内に収まるよう切り詰める', () => {
  const { mod } = loadModule();
  const slug = mod.slugifyTitle('a'.repeat(200) + ' タイトル');
  assert.ok(slug.length <= 64, `slug length ${slug.length} > 64`);
  assert.match(slug, /^[A-Za-z0-9_-]{1,64}$/);
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
    assert.equal(mod.resolveSession({ title: 'RAG構成の採用可否', workspace: ws }), mod.slugifyTitle('RAG構成の採用可否'));
  });
});

test('resolveSession: state ファイル既存時は -2, -3... の接尾辞を付与する', () => {
  const { mod } = loadModule();
  withTempWorkspace(ws => {
    const slug = mod.slugifyTitle('RAG構成の採用可否');
    // council-<slug>.json と council-<slug>-2.json が既にある場合 → <slug>-3
    fs.writeFileSync(path.join(ws, '.gh-maestro', `council-${slug}.json`), '{}', 'utf8');
    fs.writeFileSync(path.join(ws, '.gh-maestro', `council-${slug}-2.json`), '{}', 'utf8');
    assert.equal(mod.resolveSession({ title: 'RAG構成の採用可否', workspace: ws }), `${slug}-3`);
  });
});

test('resolveSession: state ファイルが無ければ接尾辞を付けない', () => {
  const { mod } = loadModule();
  withTempWorkspace(ws => {
    fs.writeFileSync(path.join(ws, '.gh-maestro', 'council-other.json'), '{}', 'utf8');
    assert.equal(mod.resolveSession({ title: 'RAG構成の採用可否', workspace: ws }), mod.slugifyTitle('RAG構成の採用可否'));
  });
});

test('resolveSession: 純日本語タイトルでも state 衝突時は -2 接尾辞が機能する', () => {
  const { mod } = loadModule();
  withTempWorkspace(ws => {
    const slug = mod.slugifyTitle('採用可否について'); // council-<hash8>
    fs.writeFileSync(path.join(ws, '.gh-maestro', `council-${slug}.json`), '{}', 'utf8');
    const session = mod.resolveSession({ title: '採用可否について', workspace: ws });
    assert.equal(session, `${slug}-2`);
    assert.match(session, /^council-[0-9a-f]{8}-2$/);
  });
});

test('resolveSession: 長いタイトルでも collision 接尾辞で SESSION_RE を超えない', () => {
  const { mod } = loadModule();
  withTempWorkspace(ws => {
    const base = 'x'.repeat(200); // slugify 後は MAX_SLUG_BASE_LEN で切り詰められる
    const slug = mod.slugifyTitle(base); // 47文字 + '-' + hash8 の56文字
    // 切り詰め後の slug そのものが既存 state と衝突するようにしておく
    fs.writeFileSync(path.join(ws, '.gh-maestro', `council-${slug}.json`), '{}', 'utf8');
    const session = mod.resolveSession({ title: base, workspace: ws });
    assert.ok(session.length <= 64, `session length ${session.length} > 64: ${session}`);
    assert.match(session, /^[A-Za-z0-9_-]{1,64}$/);
    // 接尾辞 -2 が付与され、base 側がその分だけ切り詰められている
    assert.ok(session.endsWith('-2'));
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

test('ensureCouncilWorktree: 既存worktreeのHEADが要求shaと一致すれば再利用（rev-parseのみ）', () => {
  const { mod, calls } = loadModule(() => ({ status: 0, stdout: SHA + '\n', stderr: '' }));
  withTempWorkspace(ws => {
    const dir = path.join(ws, '.gh-maestro', 'council-wt-s1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.git'), 'gitdir: ...', 'utf8');
    assert.equal(mod.ensureCouncilWorktree(ws, 's1', SHA), dir);
    // 再利用を確認するための rev-parse 1回だけ。worktree add/remove は呼ばない
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'git');
    assert.deepEqual(calls[0].args, ['rev-parse', 'HEAD']);
  });
});

test('ensureCouncilWorktree: 既存worktreeのHEADが要求shaと不一致なら付け直す', () => {
  const { mod, calls } = loadModule(() => ({ status: 0, stdout: 'ffffffffffffffffffffffffffffffffffffffff\n', stderr: '' }));
  withTempWorkspace(ws => {
    const dir = path.join(ws, '.gh-maestro', 'council-wt-s1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.git'), 'gitdir: ...', 'utf8');
    assert.equal(mod.ensureCouncilWorktree(ws, 's1', SHA), dir);
    // rev-parse → remove --force → add --detach の順で3回 git を呼ぶ
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0].args, ['rev-parse', 'HEAD']);
    assert.ok(calls[1].args.includes('worktree'));
    assert.ok(calls[1].args.includes('remove'));
    assert.ok(calls[2].args.includes('worktree'));
    assert.ok(calls[2].args.includes('add'));
    assert.ok(calls[2].args.includes(SHA));
  });
});

test('ensureCouncilWorktree: 既存worktreeのHEADが取得不能でも付け直す（fail-closed）', () => {
  const { mod, calls } = loadModule((cmd, args, opts, callIndex) => {
    // 1回目（rev-parse）だけ失敗させ、remove/add は成功させる
    if (callIndex === 0) return { status: 128, stdout: '', stderr: 'fatal: not a git repository' };
    return { status: 0, stdout: '' };
  });
  withTempWorkspace(ws => {
    const dir = path.join(ws, '.gh-maestro', 'council-wt-s1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.git'), 'gitdir: ...', 'utf8');
    assert.equal(mod.ensureCouncilWorktree(ws, 's1', SHA), dir);
    assert.equal(calls.length, 3);
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

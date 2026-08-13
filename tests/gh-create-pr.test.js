'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// gh-create-pr.js は require.main===module 時のみCLIを実行するため、
// resolveBaseBranch/createPr は純粋関数としてrequireで検証する。
// child-process.js の spawnSync をモックし、実プロセスを0個spawnする
// （.claude/rules/test-process-spawn-safety.md 準拠）。

// createPr の NODE_TEST_CONTEXT ガードは「テスト実行中の外部副作用（実PR作成）を機械的に
// 拒否する」構造的対策（Issue #202）。実PR作成の引数組み立てを検証する各テストは、
// createPr を呼ぶ直前にだけガードを一時的に除去する（withGuardBypassed）。
// ガード自体の動作は「NODE_TEST_CONTEXT 設定時はブロックされる」テストで明示的に確認する。
//
// 注: モジュール読み込み時に NODE_TEST_CONTEXT を除去してはいけない。node --test は
// ファイル読み込み時点でこの環境変数の状態を見て子プロセス分離するか決めるため、
// 読み込み時の除去は「このファイル全体を子プロセスで実行し、個別テスト数が集計されない」
// 副作用を生む（Issue #269 レビュー確認で判明。実際に dev との差分で集計数が -11 になった）。
// ガードの除去は必ずテストコールバック内・実行時に限定し、呼び出し後に元の値へ戻す。

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

/** main() が読む process.env.GH_MAESTRO_BASE_BRANCH を一時的に設定する。 */
function withBaseBranch(branch, fn) {
  const saved = process.env.GH_MAESTRO_BASE_BRANCH;
  process.env.GH_MAESTRO_BASE_BRANCH = branch;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.GH_MAESTRO_BASE_BRANCH;
    else process.env.GH_MAESTRO_BASE_BRANCH = saved;
  }
}

/**
 * main() が読む process.env.GH_MAESTRO_BASE_BRANCH を一時的に除去する。
 * 周囲の環境に設定されているか（ワーカー起動コンテキストでは PR #270 により常に設定される）
 * に依存せず、「不在」を自分で明示的に制御する（Issue #271: 不在を周囲に暗黙期待したため
 * ワーカー文脈で npm test が1件落ちていた）。
 */
function withNoBaseBranch(fn) {
  const saved = process.env.GH_MAESTRO_BASE_BRANCH;
  delete process.env.GH_MAESTRO_BASE_BRANCH;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.GH_MAESTRO_BASE_BRANCH;
    else process.env.GH_MAESTRO_BASE_BRANCH = saved;
  }
}

/**
 * createPr の NODE_TEST_CONTEXT ガード（実PR作成の機械的拒否）を、このコールバック内だけで
 * 除去して実引数組み立てを検証できるようにする。実行時に限定するのは、モジュール読み込み時
 * に除去すると node --test がこのファイルを子プロセス分離して集計から外すため
 * （上記ヘッダーコメント参照）。ガード自体の検証は「NODE_TEST_CONTEXT 設定時はブロック」テスト。
 */
function withGuardBypassed(fn) {
  const saved = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = saved;
  }
}

// ── resolveBaseBranch ───────────────────────────────────────────────────────

test('resolveBaseBranch: 環境変数から base を解決する（git を呼ばない）', () => {
  const { mod, calls } = loadModule();
  const branch = mod.resolveBaseBranch({ env: { GH_MAESTRO_BASE_BRANCH: 'dev' } });
  assert.equal(branch, 'dev');
  // upstream tracking には一切依存しない（Issue #269）: git を1回も呼ばない
  assert.equal(calls.length, 0);
});

test('resolveBaseBranch: 異なるブランチ値もそのまま返す', () => {
  const { mod, calls } = loadModule();
  assert.equal(mod.resolveBaseBranch({ env: { GH_MAESTRO_BASE_BRANCH: 'main' } }), 'main');
  assert.equal(mod.resolveBaseBranch({ env: { GH_MAESTRO_BASE_BRANCH: '  feature/x  ' } }), 'feature/x');
  assert.equal(calls.length, 0);
});

test('resolveBaseBranch: env未指定でも process.env から読む', () => {
  const { mod } = loadModule();
  assert.equal(mod.resolveBaseBranch({ env: { GH_MAESTRO_BASE_BRANCH: 'dev' } }), 'dev');
});

test('resolveBaseBranch: 未設定ならフェイルクローズ（エラー）', () => {
  const { mod, calls } = loadModule();
  assert.throws(() => mod.resolveBaseBranch({ env: {} }), {
    message: /GH_MAESTRO_BASE_BRANCH が設定されていません/,
  });
  assert.throws(() => mod.resolveBaseBranch({ env: { GH_MAESTRO_BASE_BRANCH: '  ' } }), {
    message: /GH_MAESTRO_BASE_BRANCH が設定されていません/,
  });
  assert.equal(calls.length, 0);
});

test('resolveBaseBranch: - 始まりの値はオプション注入を防ぐため拒否する', () => {
  const { mod } = loadModule();
  assert.throws(() => mod.resolveBaseBranch({ env: { GH_MAESTRO_BASE_BRANCH: '--force' } }), {
    message: /不正なベースブランチ形式/,
  });
});

// ── createPr ─────────────────────────────────────────────────────────────────

test('createPr: 環境変数のbaseを --base として gh pr create に渡す（回帰: upstream非依存）', () => {
  // 回帰テスト（Issue #269）: コーダーの標準的な `git push -u` で upstream が自ブランチを
  // 指すようになっても、base は環境変数から解決され --base に渡る。git は一切呼ばれない。
  const { mod, calls } = loadModule(() => ({ status: 0, stdout: 'https://github.com/owner/repo/pull/123\n' }));
  const result = withGuardBypassed(() => mod.createPr({ title: 'Fix bug', body: 'Closes #1', env: { GH_MAESTRO_BASE_BRANCH: 'dev' } }));
  assert.equal(result.url, 'https://github.com/owner/repo/pull/123');
  assert.equal(result.status, 0);

  const gitCall = calls.find(c => c.cmd === 'git');
  assert.equal(gitCall, undefined, 'git を1回も呼んではいけない（upstream tracking非依存）');
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

test('createPr: base が自ブランチと同名でも base==head にならず base に渡る', () => {
  // 本Issueの直接の事故形状: upstream が自ブランチを指すと旧実装は base==head で失敗した。
  // 新実装では env の値がそのまま --base に渡る。
  const { mod, calls } = loadModule(() => ({ status: 0, stdout: 'https://github.com/owner/repo/pull/1\n' }));
  withGuardBypassed(() => mod.createPr({ title: 'Fix', body: 'Closes #1', env: { GH_MAESTRO_BASE_BRANCH: 'issue-269-coder-fix-pr-base-resolution' } }));
  const ghCall = calls.find(c => c.cmd === 'gh');
  assert.equal(ghCall.args[3], 'issue-269-coder-fix-pr-base-resolution');
});

test('createPr: --repo が指定された場合に渡される', () => {
  const { mod, calls } = loadModule(() => ({ status: 0, stdout: 'https://github.com/owner/repo/pull/456\n' }));
  withGuardBypassed(() => mod.createPr({ title: 'Fix', body: 'Closes #1', repo: 'custom/repo', env: { GH_MAESTRO_BASE_BRANCH: 'dev' } }));
  const ghCall = calls.find(c => c.cmd === 'gh');
  assert.ok(ghCall.args.includes('--repo'));
  assert.ok(ghCall.args.includes('custom/repo'));
});

test('createPr: gh 失敗時に status と stderr を返す', () => {
  const { mod } = loadModule(() => ({ status: 1, stdout: '', stderr: 'gh: error: ...' }));
  const result = withGuardBypassed(() => mod.createPr({ title: 'Fix', body: 'Closes #1', env: { GH_MAESTRO_BASE_BRANCH: 'dev' } }));
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'gh: error: ...');
});

test('createPr: bodyFile が指定された場合に --body-file で渡される', () => {
  const { mod, calls } = loadModule(() => ({ status: 0, stdout: 'https://github.com/owner/repo/pull/789\n' }));
  withGuardBypassed(() => mod.createPr({ title: 'Fix', bodyFile: '/tmp/body.md', env: { GH_MAESTRO_BASE_BRANCH: 'dev' } }));
  const ghCall = calls.find(c => c.cmd === 'gh');
  assert.ok(ghCall.args.includes('--body-file'));
  assert.ok(ghCall.args.includes('/tmp/body.md'));
  assert.ok(!ghCall.args.includes('--body'));
});

test('createPr: NODE_TEST_CONTEXT 設定時は実PR作成をブロックする（フェイルクローズ）', () => {
  const { mod, calls } = loadModule();
  process.env.NODE_TEST_CONTEXT = '1';
  try {
    const result = mod.createPr({ title: 'Fix', body: 'Closes #1', env: { GH_MAESTRO_BASE_BRANCH: 'dev' } });
    assert.equal(result.status, 1);
    assert.equal(result.url, '');
    assert.match(result.stderr, /NODE_TEST_CONTEXT/);
  } finally {
    delete process.env.NODE_TEST_CONTEXT;
  }
  assert.equal(calls.length, 0, 'ブロック時は gh を呼ばない');
});

test('createPr: GH_MAESTRO_BASE_BRANCH 未設定なら実PRを作らず throw する', () => {
  const { mod, calls } = loadModule();
  assert.throws(() => withGuardBypassed(() => mod.createPr({ title: 'Fix', body: 'Closes #1', env: {} })), {
    message: /GH_MAESTRO_BASE_BRANCH が設定されていません/,
  });
  assert.equal(calls.length, 0, 'フェイルクローズ時は gh を呼ばない');
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

test('main: --help に GH_MAESTRO_BASE_BRANCH の説明を含む', () => {
  const { mod } = loadModule();
  const result = mod.main(['--help']);
  assert.ok(result.stdout.includes('GH_MAESTRO_BASE_BRANCH'));
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
  assert.ok(result.stderr.includes('未知のフラグ'));
});

test('main: 正常系でURLを出力する', () => {
  const { mod } = loadModule(() => ({ status: 0, stdout: 'https://github.com/owner/repo/pull/123\n' }));
  const result = withBaseBranch('dev', () => withGuardBypassed(() => mod.main(['--title', 'Fix bug', '--body', 'Closes #1'])));
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'https://github.com/owner/repo/pull/123');
});

test('main: gh 失敗時はエラー終了', () => {
  const { mod } = loadModule(() => ({ status: 1, stdout: '', stderr: 'gh error details' }));
  const result = withBaseBranch('dev', () => withGuardBypassed(() => mod.main(['--title', 'Fix', '--body', 'Closes #1'])));
  assert.equal(result.exitCode, 1);
  assert.ok(result.stderr.includes('gh pr create 失敗'));
});

test('main: GH_MAESTRO_BASE_BRANCH 未設定なら明確に失敗する（誤ったbaseでPRを作らない）', () => {
  const { mod, calls } = loadModule();
  // 周囲の環境に GH_MAESTRO_BASE_BRANCH が設定されていても（ワーカー文脈）、
  // 明示的に除去して「不在」を作り出す（Issue #271）。
  const result = withNoBaseBranch(() => withGuardBypassed(() => mod.main(['--title', 'Fix', '--body', 'Closes #1'])));
  assert.equal(result.exitCode, 1);
  assert.ok(result.stderr.includes('GH_MAESTRO_BASE_BRANCH'));
  assert.equal(calls.length, 0, 'フェイルクローズ時は gh を呼ばない');
});

test('main: --value フラグで値不足の場合にエラー', () => {
  const { mod } = loadModule();
  const result = mod.main(['--title']);
  assert.equal(result.exitCode, 1);
});

// ── buildPrCreateArgs（抽出された純関数: NODE_TEST_CONTEXT ガードに依存せず検証可能） ──

test('buildPrCreateArgs: baseブランチとタイトルを組み立てる', () => {
  const { mod } = loadModule();
  assert.deepEqual(mod.buildPrCreateArgs({ env: { GH_MAESTRO_BASE_BRANCH: 'dev' }, title: 'Fix bug' }),
    ['pr', 'create', '--base', 'dev', '--title', 'Fix bug']);
});

test('buildPrCreateArgs: --body は --body フラグで渡す', () => {
  const { mod } = loadModule();
  assert.deepEqual(mod.buildPrCreateArgs({ env: { GH_MAESTRO_BASE_BRANCH: 'dev' }, title: 'T', body: 'Closes #1' }),
    ['pr', 'create', '--base', 'dev', '--title', 'T', '--body', 'Closes #1']);
});

test('buildPrCreateArgs: body があれば --body-file より --body を優先する', () => {
  const { mod } = loadModule();
  assert.deepEqual(mod.buildPrCreateArgs({ env: { GH_MAESTRO_BASE_BRANCH: 'dev' }, title: 'T', body: 'x', bodyFile: '/tmp/b.md' }),
    ['pr', 'create', '--base', 'dev', '--title', 'T', '--body', 'x']);
});

test('buildPrCreateArgs: body が無ければ --body-file で渡す', () => {
  const { mod } = loadModule();
  assert.deepEqual(mod.buildPrCreateArgs({ env: { GH_MAESTRO_BASE_BRANCH: 'dev' }, title: 'T', bodyFile: '/tmp/b.md' }),
    ['pr', 'create', '--base', 'dev', '--title', 'T', '--body-file', '/tmp/b.md']);
});

test('buildPrCreateArgs: --repo は付与する', () => {
  const { mod } = loadModule();
  assert.deepEqual(mod.buildPrCreateArgs({ env: { GH_MAESTRO_BASE_BRANCH: 'dev' }, title: 'T', repo: 'owner/repo' }),
    ['pr', 'create', '--base', 'dev', '--title', 'T', '--repo', 'owner/repo']);
});

test('buildPrCreateArgs: GH_MAESTRO_BASE_BRANCH 未設定なら throw（誤ったbaseでPRを作らない）', () => {
  const { mod } = loadModule();
  assert.throws(() => mod.buildPrCreateArgs({ env: {}, title: 'T' }), /GH_MAESTRO_BASE_BRANCH/);
});

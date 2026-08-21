'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// push-and-declare.js は「ステージング・コミット・push・PR取得/作成・テスト結果申告」を
// 一つの操作にまとめた収束型の単一入口（Issue #374）。テストは child-process.js の
// spawnSync をモックし、実プロセス（git / gh）を0個spawnする
// （.claude/rules/test-process-spawn-safety.md 準拠）。
//
// モックするのは child-process.spawnSync の1点だけ。createPr（gh-create-pr.js）と
// declareTestResult（declare-test-result.js）は依存注入せず実物を通し、argvと実際の受理を
// 一緒に固定する（.claude/rules/test-child-process-argv-boundary.md: 子プロセス境界のargvを
// 注入モックで飛ばしたままにしない）。
//
// pushAndDeclare の NODE_TEST_CONTEXT ガードは「テスト実行中の外部副作用（git操作・gh操作・
// 投稿）を機械的に拒否する」構造的対策（Issue #202）。ガード自体の動作は「NODE_TEST_CONTEXT
// 設定時はブロックされる」テストで明示的に確認し、実経路の検証はガードを一時除去する
// （withGuardBypassed。実行時限定で、モジュール読み込み時に除去しない）。
//
// 注: モジュール読み込み時に NODE_TEST_CONTEXT を除去してはいけない（node --test は
// ファイル読み込み時点でこの環境変数の状態を見て子プロセス分離するか決めるため、
// 読み込み時の除去は集計数を壊す。Issue #269）。

const pushAndDeclarePath = require.resolve('../scripts/push-and-declare');

// spawnSync をキャプチャして再ロードが必要なモジュール（spawnSync を load 時に捕捉する）。
// child-process.js 自体は require.cache にモックを挿入して制御するためこの一覧に含めない
// （含めると挿入したモックが delete で消える）。
const SPAWN_CAPTURING_MODULES = [
  '../scripts/push-and-declare',
  '../scripts/gh-create-pr',
  '../scripts/declare-test-result',
  '../scripts/shared/git-head',
  '../scripts/shared/gh-comments',
];

/**
 * child-process.js の spawnSync をモックした状態で push-and-declare.js を再ロードする。
 * @param {Function} spawnSyncImpl (cmd, args, opts, callIndex) => result
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

  for (const mod of SPAWN_CAPTURING_MODULES) {
    delete require.cache[require.resolve(mod)];
  }
  const mod = require(pushAndDeclarePath);

  delete require.cache[childProcessPath];
  return { mod, calls };
}

/**
 * createPr / pushAndDeclare の NODE_TEST_CONTEXT ガード（実副作用の機械的拒否）を、
 * このコールバック内だけで除去する。実行時に限定する理由はヘッダーコメント参照。
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

/** 一時ワークスペースのパスを作る（存在は不要。git/gh はすべてモックされる）。 */
function tempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-pad-test-'));
  return dir;
}

const SHA = '0123456789abcdef0123456789abcdef01234567'; // 40桁の16進数
const BRANCH = 'issue-374-senior-coder-test-declaration';
const REPO = 'owner/repo';
const TITLE = '修正pushのたびにテスト結果の申告を既定で行えるようにする';
const PR_URL = 'https://github.com/owner/repo/pull/5';
const DECL_URL = 'https://github.com/owner/repo/pull/5#issuecomment-1';

/** ハンドラ群から、呼ばれた cmd/args に応じて結果を返す dispatcher を作る。 */
function dispatcher(handlers) {
  return (cmd, args, opts, callIndex) => {
    for (const h of handlers) {
      if (h.matches({ cmd, args })) {
        return typeof h.result === 'function' ? h.result({ cmd, args, opts, callIndex }) : h.result;
      }
    }
    // 想定外の呼び出しは失敗させる（黙って成功と解釈しない）
    return { status: 2, stdout: '', stderr: `unexpected spawnSync: ${cmd} ${args.join(' ')}` };
  };
}

const m = {
  branch: () => ({ cmd, args }) => cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref',
  repoView: () => ({ cmd, args }) => cmd === 'gh' && args[0] === 'repo' && args[1] === 'view',
  issueTitle: () => ({ cmd, args }) => cmd === 'gh' && args[0] === 'issue' && args[1] === 'view',
  add: () => ({ cmd, args }) => cmd === 'git' && args[0] === 'add',
  nameOnly: () => ({ cmd, args }) => cmd === 'git' && args[0] === 'diff' && args[1] === '--cached' && args[2] === '--name-only',
  quietDiff: () => ({ cmd, args }) => cmd === 'git' && args[0] === 'diff' && args[1] === '--cached' && args[2] === '--quiet',
  commit: () => ({ cmd, args }) => cmd === 'git' && args[0] === 'commit',
  push: () => ({ cmd, args }) => cmd === 'git' && args[0] === 'push',
  head: () => ({ cmd, args }) => cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD',
  prList: () => ({ cmd, args }) => cmd === 'gh' && args[0] === 'pr' && args[1] === 'list',
  prCreate: () => ({ cmd, args }) => cmd === 'gh' && args[0] === 'pr' && args[1] === 'create',
  commentList: () => ({ cmd, args }) => cmd === 'gh' && args[0] === 'api' && args[1] === '--method' && args[2] === 'GET',
  commentCreate: () => ({ cmd, args }) => cmd === 'gh' && args[0] === 'api' && args[1] === `repos/${REPO}/issues/${'5'}/comments` && args[2] === '-f',
};

/** 変更あり → コミット → push → PR新規作成 → 申告 のフルパス用ハンドラ。 */
function fullPathHandlers(overrides = {}) {
  return [
    { matches: m.branch(), result: { status: 0, stdout: BRANCH + '\n' } },
    { matches: m.repoView(), result: { status: 0, stdout: REPO + '\n' } },
    { matches: m.issueTitle(), result: { status: 0, stdout: TITLE + '\n' } },
    { matches: m.add(), result: { status: 0, stdout: '' } },
    { matches: m.nameOnly(), result: { status: 0, stdout: 'a.js\nb.js\n' } },
    // quietDiff: 既定は status 1（ステージ済み変更あり）。overrides.quietDiff で変更なしを注入できる
    { matches: m.quietDiff(), result: overrides.quietDiff || { status: 1, stdout: '' } },
    { matches: m.commit(), result: { status: 0, stdout: '' } },
    { matches: m.push(), result: overrides.push || { status: 0, stdout: '' } },
    { matches: m.head(), result: { status: 0, stdout: SHA + '\n' } },
    { matches: m.prList(), result: overrides.prList || { status: 0, stdout: '' } }, // 既存PRなし
    { matches: m.prCreate(), result: overrides.prCreate || { status: 0, stdout: PR_URL + '\n' } },
    { matches: m.commentList(), result: overrides.commentList || { status: 0, stdout: '[]' } },
    { matches: m.commentCreate(), result: overrides.commentCreate || { status: 0, stdout: `{"html_url":"${DECL_URL}"}` } },
  ];
}

function call(calls, predicate) {
  return calls.find(c => predicate(c.cmd, c.args));
}

// ── buildPrBody / 自動クローズガード（制約11） ─────────────────────────────────

test('buildPrBody: 関連Issue参照に留め、マージ時自動クローズキーワードを含まない', () => {
  const { mod } = loadModule();
  const body = mod.buildPrBody(374);
  assert.equal(body, '関連Issue: #374');
  // 機械生成する本文が自動クローズキーワードを含まないこと（Issueクローズは finalize-issue.js のみ）
  assert.doesNotMatch(body, mod.AUTO_CLOSE_KEYWORD_RE);
});

test('AUTO_CLOSE_KEYWORD_RE: close/fix/resolve + #番号 を実際に検出する（ガードが空虚でない）', () => {
  const { mod } = loadModule();
  for (const bad of ['Closes #374', 'fixes #374', 'Resolved #374', 'close #374']) {
    assert.match(bad, mod.AUTO_CLOSE_KEYWORD_RE, `自動クローズキーワードを見逃す: ${bad}`);
  }
  assert.doesNotMatch('関連Issue: #374', mod.AUTO_CLOSE_KEYWORD_RE);
  assert.doesNotMatch('ref #374', mod.AUTO_CLOSE_KEYWORD_RE);
});

// ── 収束の各段 ────────────────────────────────────────────────────────────────

test('収束: 変更あり→コミット→push→PR新規作成→申告で exit 0', () => {
  const { mod, calls } = loadModule(dispatcher(fullPathHandlers()));
  const ws = tempWorkspace();
  const result = withGuardBypassed(() => mod.pushAndDeclare({
    issue: 374, fail: 0, pass: 12, workspace: ws, worktree: '/worktree', env: { GH_MAESTRO_BASE_BRANCH: 'dev' },
  }));

  assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  // コミットメッセージは定型（モデル推論を挟まない）
  const commitCall = call(calls, (cmd, args) => cmd === 'git' && args[0] === 'commit');
  assert.deepEqual(commitCall.args, ['commit', '-m', `fix(issue-374): ${TITLE}`]);
  // pushは upstream を明示して押す
  const pushCall = call(calls, (cmd, args) => cmd === 'git' && args[0] === 'push');
  assert.deepEqual(pushCall.args, ['push', '-u', 'origin', BRANCH]);
  // PRは get-or-create: 既存が無いので createPr を呼ぶ
  const prCreateCall = call(calls, (cmd, args) => cmd === 'gh' && args[0] === 'pr' && args[1] === 'create');
  assert.ok(prCreateCall, 'createPr（gh pr create）が呼ばれるべき');
  assert.ok(prCreateCall.args.includes('--title'));
  assert.ok(prCreateCall.args.includes(TITLE));
  assert.ok(prCreateCall.args.includes('--body'));
  assert.ok(prCreateCall.args.includes('関連Issue: #374'));
  assert.ok(prCreateCall.args.includes('--repo'));
  assert.ok(prCreateCall.args.includes(REPO));
  // 出力にファイル一覧・コミットSHA・PR番号・申告の所在・新規作成の別を含む
  assert.match(result.stdout, /ブランチ: issue-374-senior-coder-test-declaration/);
  assert.match(result.stdout, /コミット: 0123456789/);
  assert.match(result.stdout, /PR: #5（新規作成）/);
  assert.match(result.stdout, /申告: https:\/\/github.com\/owner\/repo\/pull\/5#issuecomment-1/);
  assert.match(result.stdout, /コミット対象ファイル:/);
  assert.match(result.stdout, /  a\.js/);
  assert.match(result.stdout, /  b\.js/);
});

test('収束: ステージ済み変更が無ければ空コミットを作らず、コミット段をスキップして push→申告で exit 0', () => {
  // quietDiff が status 0（ステージ済み変更なし）→ コミットを呼ばない
  const handlers = fullPathHandlers({ quietDiff: { status: 0, stdout: '' } });
  const { mod, calls } = loadModule(dispatcher(handlers));
  const ws = tempWorkspace();
  const result = withGuardBypassed(() => mod.pushAndDeclare({
    issue: 374, fail: 1, pass: 11, workspace: ws, worktree: '/worktree', env: { GH_MAESTRO_BASE_BRANCH: 'dev' },
  }));

  assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  const commitCall = call(calls, (cmd, args) => cmd === 'git' && args[0] === 'commit');
  assert.equal(commitCall, undefined, '変更なしでは空コミットを作らない');
  assert.match(result.stdout, /コミット: なし（ステージ済み変更が無いため、コミットは作成されませんでした）/);
  // pushと申告は実行される（前回pushし損ねたコミットの積み残しもここで載る）
  assert.ok(call(calls, (cmd, args) => cmd === 'git' && args[0] === 'push'));
  assert.ok(call(calls, (cmd, args) => cmd === 'gh' && args[0] === 'api'));
});

test('収束: 既存PRがあれば再利用し、createPr（gh pr create）を呼ばない', () => {
  const handlers = fullPathHandlers({
    prList: { status: 0, stdout: `{"number":5,"url":"${PR_URL}"}` },
  });
  const { mod, calls } = loadModule(dispatcher(handlers));
  const ws = tempWorkspace();
  const result = withGuardBypassed(() => mod.pushAndDeclare({
    issue: 374, fail: 0, pass: 8, workspace: ws, worktree: '/worktree', env: { GH_MAESTRO_BASE_BRANCH: 'dev' },
  }));

  assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  const prCreateCall = call(calls, (cmd, args) => cmd === 'gh' && args[0] === 'pr' && args[1] === 'create');
  assert.equal(prCreateCall, undefined, '既存PRがある場合は gh pr create を呼ばない');
  assert.match(result.stdout, /PR: #5（既存を使用）/);
});

// ── 終了コード契約 ────────────────────────────────────────────────────────────

test('終了コード: push失敗は exit 2（リモート未変更）', () => {
  const handlers = fullPathHandlers({
    push: { status: 1, stdout: '', stderr: '! [rejected] non-fast-forward' },
  });
  const { mod, calls } = loadModule(dispatcher(handlers));
  const ws = tempWorkspace();
  const result = withGuardBypassed(() => mod.pushAndDeclare({
    issue: 374, fail: 0, pass: 1, workspace: ws, worktree: '/worktree', env: { GH_MAESTRO_BASE_BRANCH: 'dev' },
  }));

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /git push に失敗しました/);
  // 申告以降の呼び出し（gh pr / gh api）に到達していない
  assert.ok(call(calls, (cmd, args) => cmd === 'git' && args[0] === 'push'));
  assert.equal(call(calls, (cmd, args) => cmd === 'gh' && args[0] === 'pr'), undefined);
  assert.equal(call(calls, (cmd, args) => cmd === 'gh' && args[0] === 'api'), undefined);
});

test('終了コード: pushは成功したが申告が失敗したら exit 3（リモートは進んだ）', () => {
  // 申告段のコメント一覧取得を失敗させる → declareTestResult が ok:false
  const handlers = fullPathHandlers({
    commentList: { status: 1, stdout: '', stderr: 'gh api failed' },
  });
  const { mod, calls } = loadModule(dispatcher(handlers));
  const ws = tempWorkspace();
  const result = withGuardBypassed(() => mod.pushAndDeclare({
    issue: 374, fail: 0, pass: 1, workspace: ws, worktree: '/worktree', env: { GH_MAESTRO_BASE_BRANCH: 'dev' },
  }));

  assert.equal(result.exitCode, 3, '申告失敗を成功として終了しない（最重要不変条件）');
  assert.match(result.stderr, /テスト結果の申告に失敗しました/);
  // pushは成功している（exit 2 と区別する境界）
  assert.ok(call(calls, (cmd, args) => cmd === 'git' && args[0] === 'push'));
});

test('終了コード: ブランチ名規約不一致は exit 1 で副作用ゼロ（git add 以降に到達しない）', () => {
  const handlers = [
    { matches: m.branch(), result: { status: 0, stdout: 'main\n' } }, // --issue 374 と不一致
  ];
  const { mod, calls } = loadModule(dispatcher(handlers));
  const ws = tempWorkspace();
  const result = withGuardBypassed(() => mod.pushAndDeclare({
    issue: 374, fail: 0, pass: 1, workspace: ws, worktree: '/worktree', env: { GH_MAESTRO_BASE_BRANCH: 'dev' },
  }));

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /ブランチ名がIssue番号と一致しません/);
  assert.equal(calls.length, 1, 'ブランチ検証以降の副作用（git add 等）を実行しない');
});

test('終了コード: 引数不正（--issue が整数でない）は exit 1 で副作用ゼロ', () => {
  const { mod, calls } = loadModule(dispatcher(fullPathHandlers()));
  const ws = tempWorkspace();
  const result = withGuardBypassed(() => mod.pushAndDeclare({
    issue: 'abc', fail: 0, pass: 1, workspace: ws, worktree: '/worktree', env: { GH_MAESTRO_BASE_BRANCH: 'dev' },
  }));

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /--issue は正の整数/);
  assert.equal(calls.length, 0, '検証失敗時は何も実行しない');
});

test('終了コード: テストが赤（fail>0）でも exit 0 で完走し、赤として申告される', () => {
  const { mod, calls } = loadModule(dispatcher(fullPathHandlers()));
  const ws = tempWorkspace();
  const result = withGuardBypassed(() => mod.pushAndDeclare({
    issue: 374, fail: 3, pass: 9, workspace: ws, worktree: '/worktree', env: { GH_MAESTRO_BASE_BRANCH: 'dev' },
  }));

  assert.equal(result.exitCode, 0, '赤でも一連は完走して赤を申告する（関門を設けない）');
  // 申告本体（declareTestResult のコメント投稿）が失敗件数を載せている
  const createCall = call(calls, (cmd, args) => cmd === 'gh' && args[0] === 'api' && args[2] === '-f');
  assert.ok(createCall, '申告コメント投稿が呼ばれる');
  assert.match(createCall.args[3], /fail: 3/);
  assert.match(createCall.args[3], /pass: 9/);
});

// ── NODE_TEST_CONTEXT ガード（Issue #202 の構造的対策） ────────────────────────

test('NODE_TEST_CONTEXT 設定時は実副作用を実行せず拒否する（フェイルクローズ）', () => {
  const { mod, calls } = loadModule();
  const ws = tempWorkspace();
  process.env.NODE_TEST_CONTEXT = '1';
  try {
    const result = mod.pushAndDeclare({
      issue: 374, fail: 0, pass: 1, workspace: ws, worktree: '/worktree', env: { GH_MAESTRO_BASE_BRANCH: 'dev' },
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /NODE_TEST_CONTEXT/);
  } finally {
    delete process.env.NODE_TEST_CONTEXT;
  }
  assert.equal(calls.length, 0, 'ガード時は git/gh を1回も呼ばない');
});

// ── main（CLIエントリポイント） ──────────────────────────────────────────────

test('main: --help で usage を出力し exit 0（skill-asset-help ルール）', () => {
  const { mod } = loadModule();
  const result = mod.main(['--help']);
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.includes('Usage'));
  assert.ok(result.stdout.includes('push-and-declare.js'));
});

test('main: -h でも usage を出力し exit 0', () => {
  const { mod } = loadModule();
  const result = mod.main(['-h']);
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.includes('Usage'));
});

test('main: 必須引数欠落は exit 1（usage は stderr）', () => {
  const { mod } = loadModule();
  const result = mod.main([]);
  assert.equal(result.exitCode, 1);
  assert.ok(result.stderr.includes('--issue'));
  assert.ok(result.stderr.includes('--fail'));
  assert.ok(result.stderr.includes('--pass'));
});

test('main: 未知フラグ・余分な位置引数は exit 1', () => {
  const { mod } = loadModule();
  const result = mod.main(['--issue', '374', '--fail', '0', '--pass', '1', '--bogus']);
  assert.equal(result.exitCode, 1);
  assert.ok(result.stderr.includes('未知のフラグ'));
});

test('main: NODE_TEST_CONTEXT 環境下では実副作用を実行せず拒否する', () => {
  const { mod, calls } = loadModule();
  const ws = tempWorkspace();
  process.env.NODE_TEST_CONTEXT = '1';
  try {
    const result = mod.main(['--issue', '374', '--fail', '0', '--pass', '1', '--workspace', ws]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /NODE_TEST_CONTEXT/);
  } finally {
    delete process.env.NODE_TEST_CONTEXT;
  }
  assert.equal(calls.length, 0);
});

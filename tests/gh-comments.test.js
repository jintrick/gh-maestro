'use strict';

const { test } = require('node:test');
const assert = require('assert');
const ghComments = require('../scripts/shared/gh-comments');

// ── parseCommentsResponse（gh api --paginate --slurp 応答のフラット化） ────

test('parseCommentsResponse: ページ配列の配列（--paginate --slurp形状）をフラット化する', () => {
  const stdout = JSON.stringify([[{ id: 1 }, { id: 2 }], [{ id: 3 }]]);
  assert.deepEqual(ghComments.parseCommentsResponse(stdout), [{ id: 1 }, { id: 2 }, { id: 3 }]);
});

test('parseCommentsResponse: 単一ページのみでも正しくフラット化する（実測: [[c1,c2]]形状）', () => {
  const stdout = JSON.stringify([[{ id: 1 }, { id: 2 }]]);
  assert.deepEqual(ghComments.parseCommentsResponse(stdout), [{ id: 1 }, { id: 2 }]);
});

test('parseCommentsResponse: 新着なし（実測: [[]]形状）は空配列を返す', () => {
  assert.deepEqual(ghComments.parseCommentsResponse('[[]]'), []);
});

test('parseCommentsResponse: フラットなコメント配列（--paginate不使用の旧形状・テストモック）はそのまま返す（後方互換）', () => {
  const stdout = JSON.stringify([{ id: 1 }, { id: 2 }]);
  assert.deepEqual(ghComments.parseCommentsResponse(stdout), [{ id: 1 }, { id: 2 }]);
});

test('parseCommentsResponse: 空配列・未指定は空配列を返す', () => {
  assert.deepEqual(ghComments.parseCommentsResponse('[]'), []);
  assert.deepEqual(ghComments.parseCommentsResponse(undefined), []);
});

test('parseCommentsResponse: 配列でないトップレベルは null を返す', () => {
  assert.equal(ghComments.parseCommentsResponse(JSON.stringify({ foo: 'bar' })), null);
});

test('parseCommentsResponse: 壊れた JSON は例外を投げる（呼び出し側で catch する契約）', () => {
  assert.throws(() => ghComments.parseCommentsResponse('{not json'));
});

// ── listComments（gh api 引数構築の検証） ──────────────────────────────────

test('listComments: 基本のgh api引数が正しく構築される', () => {
  let capturedCmd, capturedArgs, capturedOpts;
  ghComments._setSpawnSync((cmd, args, opts) => {
    capturedCmd = cmd;
    capturedArgs = args;
    capturedOpts = opts;
    return { status: 0, stdout: '[]' };
  });
  ghComments.listComments('test/repo', 42);
  assert.equal(capturedCmd, 'gh');
  assert.deepEqual(capturedArgs, [
    'api', '--method', 'GET',
    'repos/test/repo/issues/42/comments',
    '--paginate', '--slurp',
  ]);
  assert.equal(capturedOpts.encoding, 'utf8');
  assert.equal(capturedOpts.timeout, 30000);
});

test('listComments: since 指定時に -f since= が追加される', () => {
  let capturedArgs;
  ghComments._setSpawnSync((cmd, args) => {
    capturedArgs = args;
    return { status: 0, stdout: '[]' };
  });
  ghComments.listComments('test/repo', 42, { since: '2024-06-01T00:00:00Z' });
  assert.ok(capturedArgs.includes('-f'), 'should use -f flag');
  const sinceIdx = capturedArgs.indexOf('-f');
  assert.ok(capturedArgs[sinceIdx + 1] === 'since=2024-06-01T00:00:00Z',
    `expected "since=2024-06-01T00:00:00Z" but got "${capturedArgs[sinceIdx + 1]}"`);
});

test('listComments: per_page 指定時に -f per_page= が追加される', () => {
  let capturedArgs;
  ghComments._setSpawnSync((cmd, args) => {
    capturedArgs = args;
    return { status: 0, stdout: '[]' };
  });
  ghComments.listComments('test/repo', 42, { per_page: 100 });
  const fIdx = capturedArgs.indexOf('-f');
  assert.ok(fIdx >= 0, 'should have -f flag');
  assert.ok(capturedArgs[fIdx + 1] === 'per_page=100',
    `expected "per_page=100" but got "${capturedArgs[fIdx + 1]}"`);
});

test('listComments: since と per_page の両方を指定できる', () => {
  let capturedArgs;
  ghComments._setSpawnSync((cmd, args) => {
    capturedArgs = args;
    return { status: 0, stdout: '[]' };
  });
  ghComments.listComments('test/repo', 42, { since: '2024-06-01T00:00:00Z', per_page: 100 });
  const sinceF = capturedArgs.indexOf('since=2024-06-01T00:00:00Z');
  const perPageF = capturedArgs.indexOf('per_page=100');
  assert.ok(sinceF >= 0, 'since should be in args');
  assert.ok(perPageF >= 0, 'per_page should be in args');
});


test('listComments: spawnSync options（cwd等）が透過的に渡される', () => {
  let capturedOpts;
  ghComments._setSpawnSync((cmd, args, opts) => {
    capturedOpts = opts;
    return { status: 0, stdout: '[]' };
  });
  ghComments.listComments('test/repo', 42, { cwd: '/some/path' });
  assert.equal(capturedOpts.cwd, '/some/path');
  // 既定の timeout が維持されていることを確認
  assert.equal(capturedOpts.timeout, 30000);
});

test('listComments: timeout を上書きできる', () => {
  let capturedOpts;
  ghComments._setSpawnSync((cmd, args, opts) => {
    capturedOpts = opts;
    return { status: 0, stdout: '[]' };
  });
  ghComments.listComments('test/repo', 42, { timeout: 5000 });
  assert.equal(capturedOpts.timeout, 5000);
});

test('createComment / updateComment: 32KB超の日本語本文を argv に載せず -F body=@- と opts.input (UTF-8) で渡す', () => {
  const largeBody = '日本語コメント本文-境界確認用。\n'.repeat(2500);
  assert.ok(Buffer.byteLength(largeBody, 'utf8') > 32768, 'テスト前提: 32KB超の日本語本文');

  const calls = [];
  ghComments._setSpawnSync((cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { status: 0, stdout: '{"id":1,"html_url":"https://example.test/1"}' };
  });

  try {
    ghComments.createComment('owner/repo', 42, largeBody, { cwd: '/tmp/ws' });
    ghComments.updateComment('owner/repo', 999, largeBody, { cwd: '/tmp/ws' });
  } finally {
    ghComments._setSpawnSync(require('../scripts/shared/child-process').spawnSync);
  }

  assert.equal(calls.length, 2);
  assert.equal(calls[0].cmd, 'gh');
  assert.deepEqual(calls[0].args, ['api', 'repos/owner/repo/issues/42/comments', '-X', 'POST', '-F', 'body=@-']);
  assert.equal(calls[1].cmd, 'gh');
  assert.deepEqual(calls[1].args, ['api', 'repos/owner/repo/issues/comments/999', '-X', 'PATCH', '-F', 'body=@-']);
  for (const call of calls) {
    assert.ok(call.args.join(' ').length < 256, '本文をコマンドライン引数に含めない');
    assert.equal(call.opts.encoding, 'utf8');
    assert.equal(call.opts.timeout, 30000);
    assert.equal(call.opts.cwd, '/tmp/ws');
    assert.equal(call.opts.input, largeBody);
  }
});

test('createComment / updateComment: opts.spawnSyncFn が指定されたら既定 _spawnSync より優先して使用する', () => {
  const customCalls = [];
  ghComments._setSpawnSync(() => { throw new Error('既定の _spawnSync は呼ばれない'); });
  try {
    ghComments.createComment('o/r', 5, '本文A', {
      spawnSyncFn: (cmd, args, opts) => { customCalls.push({ cmd, args, opts }); return { status: 0, stdout: '{}' }; },
    });
    ghComments.updateComment('o/r', 77, '本文B', {
      spawnSyncFn: (cmd, args, opts) => { customCalls.push({ cmd, args, opts }); return { status: 0, stdout: '{}' }; },
    });
  } finally {
    ghComments._setSpawnSync(require('../scripts/shared/child-process').spawnSync);
  }
  assert.equal(customCalls.length, 2);
  assert.equal(customCalls[0].opts.input, '本文A');
  assert.equal(customCalls[1].opts.input, '本文B');
});

test('ghApiWithBody: endpoint・extraArgs・stdin・共通 timeout を組み立てる', () => {
  const calls = [];
  const res = ghComments.ghApiWithBody('repos/o/r/pulls/9/comments', '指摘本文', ['-f', 'event=COMMENT'], {
    spawnSyncFn: (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { status: 0, stdout: '{}' };
    },
  });
  assert.equal(res.status, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'gh');
  assert.deepEqual(calls[0].args, ['api', 'repos/o/r/pulls/9/comments', '-X', 'POST', '-F', 'body=@-', '-f', 'event=COMMENT']);
  assert.equal(calls[0].opts.timeout, ghComments.GH_TIMEOUT_MS);
  assert.equal(calls[0].opts.encoding, 'utf8');
  assert.equal(calls[0].opts.input, '指摘本文');
});

test('createPrComment / ghErrorDetail: NODE_TEST_CONTEXT 既定ガードと allowRealGhInTest による stdin 投稿を検証する', () => {
  const blockedCalls = [];
  const blocked = ghComments.createPrComment('o/r', 15, '本文', {
    spawnSyncFn: (...args) => {
      blockedCalls.push(args);
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /NODE_TEST_CONTEXT/);
  assert.equal(blockedCalls.length, 0, '既定では NODE_TEST_CONTEXT 下で spawnSync を呼ばない');

  const calls = [];
  const ok = ghComments.createPrComment('o/r', 15, 'PRコメント本文', {
    allowRealGhInTest: true,
    spawnSyncFn: (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { status: 0, stdout: 'https://github.com/o/r/pull/15#issuecomment-1\n', stderr: '' };
    },
  });
  assert.equal(ok.status, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'gh');
  assert.deepEqual(calls[0].args, ['pr', 'comment', '15', '--repo', 'o/r', '--body-file', '-']);
  assert.equal(calls[0].opts.timeout, ghComments.GH_TIMEOUT_MS);
  assert.equal(calls[0].opts.stdio, 'pipe');
  assert.equal(calls[0].opts.input, 'PRコメント本文');

  const epipe = ghComments.createPrComment('o/r', 15, '本文', {
    allowRealGhInTest: true,
    spawnSyncFn: () => ({ status: null, stdout: '', stderr: '', error: new Error('write EPIPE') }),
  });
  assert.equal(epipe.stderr, 'write EPIPE');
  assert.equal(ghComments.ghErrorDetail({ status: null, stderr: '', error: new Error('spawn ETIMEDOUT') }), 'spawn ETIMEDOUT');
  assert.equal(ghComments.ghErrorDetail({ status: 1, stderr: '  stderr err \n', error: new Error('ignored') }), 'stderr err');
  assert.equal(ghComments.ghErrorDetail({ status: 1, stderr: '' }, { fallback: '(fallback)' }), '(fallback)');
});

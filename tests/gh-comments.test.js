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

test('listComments: since と per_page が未指定でも引数に余計な -f は付かない', () => {
  let capturedArgs;
  ghComments._setSpawnSync((cmd, args) => {
    capturedArgs = args;
    return { status: 0, stdout: '[]' };
  });
  ghComments.listComments('test/repo', 42);
  // --paginate と --slurp 以外に -f が無いことを確認
  const fCount = capturedArgs.filter(a => a === '-f').length;
  assert.equal(fCount, 0, 'no -f flags should appear when since/per_page not specified');
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

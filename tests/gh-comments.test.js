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

test('listComments: 引数が正しく構築される', () => {
  ghComments._setListComments((repo, issue, opts) => {
    assert.equal(repo, 'test/repo');
    assert.equal(issue, 42);
    assert.equal(opts.since, undefined);
    assert.equal(opts.per_page, undefined);
    return { status: 0, stdout: '[]' };
  });
  const result = ghComments.listComments('test/repo', 42, {});
  assert.equal(result.status, 0);
});

test('listComments: since と per_page が指定された場合は引数に含まれる', () => {
  ghComments._setListComments((repo, issue, opts) => {
    assert.equal(opts.since, '2024-06-01T00:00:00Z');
    assert.equal(opts.per_page, 100);
    return { status: 0, stdout: '[]' };
  });
  ghComments.listComments('test/repo', 42, { since: '2024-06-01T00:00:00Z', per_page: 100 });
});

test('listComments: since と per_page が未指定でも動作する', () => {
  ghComments._setListComments((repo, issue, opts) => {
    assert.equal(opts.since, undefined);
    assert.equal(opts.per_page, undefined);
    return { status: 0, stdout: '[]' };
  });
  ghComments.listComments('test/repo', 42);
});

test('listComments: spawnSync opts（cwd等）が透過的に渡される', () => {
  ghComments._setListComments((repo, issue, opts) => {
    assert.equal(opts.cwd, '/some/path');
    return { status: 0, stdout: '[]' };
  });
  ghComments.listComments('test/repo', 42, { cwd: '/some/path' });
});

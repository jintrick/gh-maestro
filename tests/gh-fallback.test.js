'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ghFallback = require('../scripts/shared/gh-fallback');

// ── isRetryableGhFailure ─────────────────────────────────────────────────

test('status 0 はフォールバック対象ではない', () => {
  assert.equal(ghFallback.isRetryableGhFailure({ status: 0 }), false);
});

test('HTTP 5xx はフォールバック対象', () => {
  assert.equal(ghFallback.isRetryableGhFailure({ status: 1, stderr: 'HTTP 503: Service Unavailable' }), true);
  assert.equal(ghFallback.isRetryableGhFailure({ status: 1, stderr: 'gh: HTTP 500 Internal Server Error' }), true);
});

test('ネットワークエラーコードはフォールバック対象', () => {
  assert.equal(ghFallback.isRetryableGhFailure({ status: 1, error: { code: 'ETIMEDOUT' } }), true);
  assert.equal(ghFallback.isRetryableGhFailure({ status: 1, error: { code: 'ECONNRESET' } }), true);
});

test('HTTP 4xx はフォールバック対象外', () => {
  assert.equal(ghFallback.isRetryableGhFailure({ status: 1, stderr: 'HTTP 404: Not Found' }), false);
  assert.equal(ghFallback.isRetryableGhFailure({ status: 1, stderr: 'HTTP 403: Forbidden' }), false);
});

test('不明なエラーはフォールバック対象外（フェイルクローズ）', () => {
  assert.equal(ghFallback.isRetryableGhFailure({ status: 1, stderr: 'invalid argument' }), false);
});

test('resultがnull/undefinedでも例外にならない', () => {
  assert.equal(ghFallback.isRetryableGhFailure(null), false);
  assert.equal(ghFallback.isRetryableGhFailure(undefined), false);
});

// ── graphqlAddComment ────────────────────────────────────────────────────

test('graphqlAddComment: issue node ID解決 → addComment の2段階呼び出しでURLを返す', () => {
  const calls = [];
  ghFallback._setGraphqlExec((args, opts) => {
    calls.push({ args, opts });
    if (args.some(a => typeof a === 'string' && a.includes('addComment'))) {
      return { status: 0, stdout: JSON.stringify({ data: { addComment: { commentEdge: { node: { url: 'https://github.com/test/repo/issues/1#issuecomment-9' } } } } }) };
    }
    return { status: 0, stdout: JSON.stringify({ data: { repository: { issue: { id: 'ISSUE_NODE_ID' } } } }) };
  });

  const result = ghFallback.graphqlAddComment({ repo: 'test/repo', issue: 1, body: 'hello' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'https://github.com/test/repo/issues/1#issuecomment-9\n');
  assert.equal(calls.length, 2);
});

test('graphqlAddComment: bodyは-F(型変換magic経由の@-読み込み)で渡し、-fにしない（実機でリテラル"@-"化するバグの再発防止）', () => {
  const calls = [];
  ghFallback._setGraphqlExec((args, opts) => {
    calls.push(args);
    if (args.some(a => typeof a === 'string' && a.includes('addComment'))) {
      return { status: 0, stdout: JSON.stringify({ data: { addComment: { commentEdge: { node: { url: 'https://github.com/test/repo/issues/1#issuecomment-9' } } } } }) };
    }
    return { status: 0, stdout: JSON.stringify({ data: { repository: { issue: { id: 'ISSUE_NODE_ID' } } } }) };
  });

  ghFallback.graphqlAddComment({ repo: 'test/repo', issue: 1, body: 'hello' });
  const commentCallArgs = calls.find(args => args.some(a => typeof a === 'string' && a.includes('addComment')));
  const bodyFlagIndex = commentCallArgs.indexOf('body=@-');
  assert.ok(bodyFlagIndex > 0);
  assert.equal(commentCallArgs[bodyFlagIndex - 1], '-F');
});

test('graphqlAddComment: issue node ID解決に失敗したらそのまま返す', () => {
  ghFallback._setGraphqlExec(() => ({ status: 1, stderr: 'HTTP 500' }));
  const result = ghFallback.graphqlAddComment({ repo: 'test/repo', issue: 1, body: 'hello' });
  assert.equal(result.status, 1);
});

// ── graphqlListComments ──────────────────────────────────────────────────

test('graphqlListComments: databaseId/body/createdAt/authorAssociationをREST互換配列に変換する', () => {
  ghFallback._setGraphqlExec(() => ({
    status: 0,
    stdout: JSON.stringify({
      data: {
        repository: {
          issue: {
            comments: {
              nodes: [
                { databaseId: 111, body: 'old', createdAt: '2026-07-17T10:00:00Z', authorAssociation: 'MEMBER' },
                { databaseId: 222, body: 'new', createdAt: '2026-07-17T12:00:00Z', authorAssociation: 'OWNER' },
              ],
            },
          },
        },
      },
    }),
  }));

  const result = ghFallback.graphqlListComments({ repo: 'test/repo', issue: 1 });
  assert.equal(result.status, 0);
  const comments = JSON.parse(result.stdout);
  assert.deepEqual(comments, [
    { id: 111, body: 'old', created_at: '2026-07-17T10:00:00Z', author_association: 'MEMBER' },
    { id: 222, body: 'new', created_at: '2026-07-17T12:00:00Z', author_association: 'OWNER' },
  ]);
});

test('graphqlListComments: sinceが指定されるとcreatedAtで絞り込む', () => {
  ghFallback._setGraphqlExec(() => ({
    status: 0,
    stdout: JSON.stringify({
      data: {
        repository: {
          issue: {
            comments: {
              nodes: [
                { databaseId: 111, body: 'old', createdAt: '2026-07-17T10:00:00Z' },
                { databaseId: 222, body: 'new', createdAt: '2026-07-17T12:00:00Z' },
              ],
            },
          },
        },
      },
    }),
  }));

  const result = ghFallback.graphqlListComments({ repo: 'test/repo', issue: 1, since: '2026-07-17T11:00:00Z' });
  const comments = JSON.parse(result.stdout);
  assert.deepEqual(comments, [{ id: 222, body: 'new', created_at: '2026-07-17T12:00:00Z' }]);
});

// ── graphqlCommentBody ───────────────────────────────────────────────────

test('graphqlCommentBody: issue未指定はエラー', () => {
  const result = ghFallback.graphqlCommentBody({ repo: 'test/repo', issue: null, commentId: 1 });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes('--issue'));
});

test('graphqlCommentBody: databaseId一致するコメントのbodyを返す', () => {
  ghFallback._setGraphqlExec(() => ({
    status: 0,
    stdout: JSON.stringify({
      data: {
        repository: {
          issue: {
            comments: {
              nodes: [
                { databaseId: 111, body: 'body-111', createdAt: '2026-07-17T10:00:00Z' },
                { databaseId: 222, body: 'body-222', createdAt: '2026-07-17T12:00:00Z' },
              ],
            },
          },
        },
      },
    }),
  }));

  const result = ghFallback.graphqlCommentBody({ repo: 'test/repo', issue: 1, commentId: '222' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'body-222');
});

test('graphqlCommentBody: 一致するコメントが無ければエラー', () => {
  ghFallback._setGraphqlExec(() => ({
    status: 0,
    stdout: JSON.stringify({ data: { repository: { issue: { comments: { nodes: [] } } } } }),
  }));

  const result = ghFallback.graphqlCommentBody({ repo: 'test/repo', issue: 1, commentId: '999' });
  assert.equal(result.status, 1);
});

// ── graphqlCreateIssue ───────────────────────────────────────────────────

test('graphqlCreateIssue: repository ID解決 → createIssue の2段階呼び出しでURLを返す', () => {
  const calls = [];
  ghFallback._setGraphqlExec((args) => {
    calls.push(args);
    if (args.some(a => typeof a === 'string' && a.includes('createIssue'))) {
      return { status: 0, stdout: JSON.stringify({ data: { createIssue: { issue: { number: 42, url: 'https://github.com/test/repo/issues/42' } } } }) };
    }
    return { status: 0, stdout: JSON.stringify({ data: { repository: { id: 'REPO_NODE_ID' } } }) };
  });

  const result = ghFallback.graphqlCreateIssue({ repo: 'test/repo', title: 't', body: 'b' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'https://github.com/test/repo/issues/42\n');
  assert.equal(calls.length, 2);
});

test('graphqlCreateIssue: bodyは-Fで渡す（-fにするとリテラル"@-"化するバグの再発防止）', () => {
  const calls = [];
  ghFallback._setGraphqlExec((args) => {
    calls.push(args);
    if (args.some(a => typeof a === 'string' && a.includes('createIssue'))) {
      return { status: 0, stdout: JSON.stringify({ data: { createIssue: { issue: { number: 42, url: 'https://github.com/test/repo/issues/42' } } } }) };
    }
    return { status: 0, stdout: JSON.stringify({ data: { repository: { id: 'REPO_NODE_ID' } } }) };
  });

  ghFallback.graphqlCreateIssue({ repo: 'test/repo', title: 't', body: 'b' });
  const createCallArgs = calls.find(args => args.some(a => typeof a === 'string' && a.includes('createIssue')));
  const bodyFlagIndex = createCallArgs.indexOf('body=@-');
  assert.ok(bodyFlagIndex > 0);
  assert.equal(createCallArgs[bodyFlagIndex - 1], '-F');
});

// ── リセット（後続テストのため） ────────────────────────────────────────────

test('injected graphql exec can be reset', () => {
  ghFallback._setGraphqlExec(() => ({ status: 0, stdout: '{}' }));
});

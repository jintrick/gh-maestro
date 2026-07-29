'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { publishPlan, PLAN_MARKER, parseCommentsResponse } = require('../scripts/publish-plan');

const MARKER = PLAN_MARKER;

// ── parseCommentsResponse ─────────────────────────────────────────────────

test('parseCommentsResponse: --paginate --slurp のページ配列を平坦化する', () => {
  const result = parseCommentsResponse(JSON.stringify([
    [{ id: 1, body: 'a' }, { id: 2, body: 'b' }],
    [{ id: 3, body: 'c' }],
  ]));
  assert.deepEqual(result, [{ id: 1, body: 'a' }, { id: 2, body: 'b' }, { id: 3, body: 'c' }]);
});

test('parseCommentsResponse: 平坦な配列はそのまま返す（テスト用モック後方互換）', () => {
  const result = parseCommentsResponse(JSON.stringify([{ id: 1 }, { id: 2 }]));
  assert.deepEqual(result, [{ id: 1 }, { id: 2 }]);
});

test('parseCommentsResponse: 空配列', () => {
  assert.deepEqual(parseCommentsResponse('[]'), []);
});

test('parseCommentsResponse: 配列でないJSONはnull', () => {
  assert.equal(parseCommentsResponse('{"message":"error"}'), null);
});

test('parseCommentsResponse: 空文字列は空配列', () => {
  assert.deepEqual(parseCommentsResponse(''), []);
});

// ── publishPlan 本体 ─────────────────────────────────────────────────────

test('publishPlan: pin済み計画コメントなし → 新規投稿してpinする', () => {
  let pinCalledWith = null;
  const result = publishPlan(
    { issue: '42', body: '# Plan\n\n内容', workspace: '/tmp/ws' },
    {
      ghRepoViewFn: () => ({ status: 0, stdout: 'owner/repo\n', stderr: '' }),
      ghViewerLoginFn: () => ({ status: 0, stdout: 'coder-bot\n', stderr: '' }),
      ghListCommentsFn: () => ({ status: 0, stdout: '[]', stderr: '' }),
      ghCreateCommentFn: (issue, repo, body) => {
        assert.equal(issue, '42');
        assert.equal(repo, 'owner/repo');
        assert.ok(body.startsWith(MARKER));
        assert.ok(body.includes('# Plan\n\n内容'));
        return { status: 0, stdout: JSON.stringify({ id: 12345, html_url: 'https://github.com/owner/repo/issues/42#issuecomment-12345' }), stderr: '' };
      },
      ghPinCommentFn: (commentId, repo) => {
        pinCalledWith = { commentId, repo };
        return { status: 0, stdout: '', stderr: '' };
      },
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.action, 'created');
  assert.equal(result.url, 'https://github.com/owner/repo/issues/42#issuecomment-12345');
  assert.deepEqual(pinCalledWith, { commentId: 12345, repo: 'owner/repo' });
});

test('publishPlan: マーカー＋投稿者一致のpin済みコメントあり → 更新する', () => {
  let createCalled = false;
  let pinCalled = false;
  const updateBody = MARKER + '\n# 新しい計画';
  const pinnedComment = {
    id: 99999,
    body: MARKER + '\n古い計画',
    html_url: 'https://github.com/owner/repo/issues/42#issuecomment-99999',
    pin: { pinned_at: '2026-01-01T00:00:00Z' },
    user: { login: 'coder-bot' },
  };
  const result = publishPlan(
    { issue: '42', body: '# 新しい計画', workspace: '/tmp/ws' },
    {
      ghRepoViewFn: () => ({ status: 0, stdout: 'owner/repo\n', stderr: '' }),
      ghViewerLoginFn: () => ({ status: 0, stdout: 'coder-bot\n', stderr: '' }),
      ghListCommentsFn: () => ({ status: 0, stdout: JSON.stringify([
        { id: 1, body: '普通のコメント', pin: null, user: { login: 'human' } },
        pinnedComment,
        { id: 2, body: '別のコメント', pin: null, user: { login: 'coder-bot' } },
      ]), stderr: '' }),
      ghUpdateCommentFn: (commentId, repo, body) => {
        assert.equal(commentId, 99999);
        assert.equal(repo, 'owner/repo');
        assert.equal(body, updateBody);
        return { status: 0, stdout: JSON.stringify({ id: 99999, html_url: 'https://github.com/owner/repo/issues/42#issuecomment-99999', body: updateBody }), stderr: '' };
      },
      ghCreateCommentFn: () => { createCalled = true; return { status: 0, stdout: '{}', stderr: '' }; },
      ghPinCommentFn: () => { pinCalled = true; return { status: 0, stdout: '', stderr: '' }; },
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.action, 'updated');
  assert.equal(result.url, 'https://github.com/owner/repo/issues/42#issuecomment-99999');
  assert.equal(createCalled, false);
  assert.equal(pinCalled, false);
});

test('publishPlan: pin済みだがマーカーなし → 無視して新規投稿＋pinする（他目的pinを破壊しない）', () => {
  let pinCalledWith = null;
  const unrelatedPinned = {
    id: 111,
    body: '人間がpinしたメモ',
    pin: { pinned_at: '2026-01-01T00:00:00Z' },
    user: { login: 'human' },
  };
  const result = publishPlan(
    { issue: '42', body: '計画', workspace: '/tmp/ws' },
    {
      ghRepoViewFn: () => ({ status: 0, stdout: 'o/r\n', stderr: '' }),
      ghViewerLoginFn: () => ({ status: 0, stdout: 'coder-bot\n', stderr: '' }),
      ghListCommentsFn: () => ({ status: 0, stdout: JSON.stringify([unrelatedPinned]), stderr: '' }),
      ghCreateCommentFn: () => ({ status: 0, stdout: JSON.stringify({ id: 200, html_url: 'https://github.com/o/r/issues/42#issuecomment-200' }), stderr: '' }),
      ghPinCommentFn: (commentId, repo) => {
        pinCalledWith = { commentId, repo };
        return { status: 0, stdout: '', stderr: '' };
      },
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.action, 'created');
  assert.equal(result.url, 'https://github.com/o/r/issues/42#issuecomment-200');
  assert.deepEqual(pinCalledWith, { commentId: 200, repo: 'o/r' });
});

test('publishPlan: マーカー付きだが投稿者が異なるpin済みコメント → 無視して新規投稿', () => {
  const otherUserPinned = {
    id: 333,
    body: MARKER + '\n別の人が立てた計画',
    pin: { pinned_at: '2026-01-01T00:00:00Z' },
    user: { login: 'other-user' },
  };
  const result = publishPlan(
    { issue: '42', body: '計画', workspace: '/tmp/ws' },
    {
      ghRepoViewFn: () => ({ status: 0, stdout: 'o/r\n', stderr: '' }),
      ghViewerLoginFn: () => ({ status: 0, stdout: 'coder-bot\n', stderr: '' }),
      ghListCommentsFn: () => ({ status: 0, stdout: JSON.stringify([otherUserPinned]), stderr: '' }),
      ghCreateCommentFn: () => ({ status: 0, stdout: JSON.stringify({ id: 400, html_url: 'https://github.com/o/r/issues/42#issuecomment-400' }), stderr: '' }),
      ghPinCommentFn: () => ({ status: 0, stdout: '', stderr: '' }),
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.action, 'created');
  assert.equal(result.url, 'https://github.com/o/r/issues/42#issuecomment-400');
});

test('publishPlan: コメント一覧が--paginate --slurp形式でも正しく平坦化して検索する', () => {
  const pinnedPlan = {
    id: 500,
    body: MARKER + '\n既存計画',
    pin: { pinned_at: '2026-01-01T00:00:00Z' },
    user: { login: 'coder-bot' },
  };
  // --paginate --slurp は [[page1], [page2]] の形
  const paginated = JSON.stringify([
    [{ id: 1, body: 'コメント1', pin: null, user: { login: 'human' } }],
    [pinnedPlan],
    [{ id: 2, body: 'コメント2', pin: null, user: { login: 'human' } }],
  ]);
  const result = publishPlan(
    { issue: '42', body: '更新計画', workspace: '/tmp/ws' },
    {
      ghRepoViewFn: () => ({ status: 0, stdout: 'o/r\n', stderr: '' }),
      ghViewerLoginFn: () => ({ status: 0, stdout: 'coder-bot\n', stderr: '' }),
      ghListCommentsFn: () => ({ status: 0, stdout: paginated, stderr: '' }),
      ghUpdateCommentFn: (commentId) => {
        assert.equal(commentId, 500);
        return { status: 0, stdout: JSON.stringify({ id: 500, html_url: 'https://github.com/o/r/issues/42#issuecomment-500' }), stderr: '' };
      },
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.action, 'updated');
});

test('publishPlan: pin失敗時はok:false（作成済みコメントIDをエラーに含む）', () => {
  const result = publishPlan(
    { issue: '1', body: '計画', workspace: '/tmp/ws' },
    {
      ghRepoViewFn: () => ({ status: 0, stdout: 'a/b\n', stderr: '' }),
      ghViewerLoginFn: () => ({ status: 0, stdout: 'bot\n', stderr: '' }),
      ghListCommentsFn: () => ({ status: 0, stdout: '[]', stderr: '' }),
      ghCreateCommentFn: () => ({ status: 0, stdout: JSON.stringify({ id: 555, html_url: 'https://github.com/a/b/issues/1#issuecomment-555' }), stderr: '' }),
      ghPinCommentFn: () => ({ status: 1, stdout: '', stderr: 'Not Found' }),
    }
  );

  assert.equal(result.ok, false);
  assert.ok(result.error.includes('commentId=555'));
  assert.ok(result.error.includes('再試行'));
});

test('publishPlan: リポジトリ解決失敗時はok:false', () => {
  const result = publishPlan(
    { issue: '42', body: '計画', workspace: '/tmp/ws' },
    {
      ghRepoViewFn: () => ({ status: 1, stdout: '', stderr: 'not a git repo' }),
    }
  );

  assert.equal(result.ok, false);
  assert.ok(result.error.includes('リポジトリを解決できません'));
});

test('publishPlan: ユーザー取得失敗時はok:false', () => {
  const result = publishPlan(
    { issue: '42', body: '計画', workspace: '/tmp/ws' },
    {
      ghRepoViewFn: () => ({ status: 0, stdout: 'o/r\n', stderr: '' }),
      ghViewerLoginFn: () => ({ status: 1, stdout: '', stderr: 'unauthorized' }),
    }
  );

  assert.equal(result.ok, false);
  assert.ok(result.error.includes('現在のユーザーを取得できません'));
});

test('publishPlan: ユーザー名が空の場合はok:false', () => {
  const result = publishPlan(
    { issue: '42', body: '計画', workspace: '/tmp/ws' },
    {
      ghRepoViewFn: () => ({ status: 0, stdout: 'o/r\n', stderr: '' }),
      ghViewerLoginFn: () => ({ status: 0, stdout: '\n', stderr: '' }),
    }
  );

  assert.equal(result.ok, false);
  assert.ok(result.error.includes('解決できません'));
});

test('publishPlan: コメント一覧取得失敗時はok:false', () => {
  const result = publishPlan(
    { issue: '42', body: '計画', workspace: '/tmp/ws' },
    {
      ghRepoViewFn: () => ({ status: 0, stdout: 'o/r\n', stderr: '' }),
      ghViewerLoginFn: () => ({ status: 0, stdout: 'bot\n', stderr: '' }),
      ghListCommentsFn: () => ({ status: 1, stdout: '', stderr: 'Not Found' }),
    }
  );

  assert.equal(result.ok, false);
  assert.ok(result.error.includes('コメント一覧の取得に失敗'));
});

test('publishPlan: コメント一覧が不正なJSONのときはok:false', () => {
  const result = publishPlan(
    { issue: '42', body: '計画', workspace: '/tmp/ws' },
    {
      ghRepoViewFn: () => ({ status: 0, stdout: 'o/r\n', stderr: '' }),
      ghViewerLoginFn: () => ({ status: 0, stdout: 'bot\n', stderr: '' }),
      ghListCommentsFn: () => ({ status: 0, stdout: 'not json', stderr: '' }),
    }
  );

  assert.equal(result.ok, false);
  assert.ok(result.error.includes('JSONパースに失敗'));
});

test('publishPlan: コメント一覧が配列でない場合はok:false', () => {
  const result = publishPlan(
    { issue: '42', body: '計画', workspace: '/tmp/ws' },
    {
      ghRepoViewFn: () => ({ status: 0, stdout: 'o/r\n', stderr: '' }),
      ghViewerLoginFn: () => ({ status: 0, stdout: 'bot\n', stderr: '' }),
      ghListCommentsFn: () => ({ status: 0, stdout: '{"message":"error"}', stderr: '' }),
    }
  );

  assert.equal(result.ok, false);
  assert.ok(result.error.includes('形式が不正'));
});

test('publishPlan: 更新のgh api失敗時はok:false', () => {
  const result = publishPlan(
    { issue: '42', body: '計画', workspace: '/tmp/ws' },
    {
      ghRepoViewFn: () => ({ status: 0, stdout: 'o/r\n', stderr: '' }),
      ghViewerLoginFn: () => ({ status: 0, stdout: 'bot\n', stderr: '' }),
      ghListCommentsFn: () => ({ status: 0, stdout: JSON.stringify([{ id: 1, body: MARKER + '\nold', pin: {}, user: { login: 'bot' } }]), stderr: '' }),
      ghUpdateCommentFn: () => ({ status: 1, stdout: '', stderr: 'validation error' }),
    }
  );

  assert.equal(result.ok, false);
  assert.ok(result.error.includes('pin済み計画コメントの更新に失敗'));
});

test('publishPlan: 作成のgh api失敗時はok:false', () => {
  const result = publishPlan(
    { issue: '42', body: '計画', workspace: '/tmp/ws' },
    {
      ghRepoViewFn: () => ({ status: 0, stdout: 'o/r\n', stderr: '' }),
      ghViewerLoginFn: () => ({ status: 0, stdout: 'bot\n', stderr: '' }),
      ghListCommentsFn: () => ({ status: 0, stdout: '[]', stderr: '' }),
      ghCreateCommentFn: () => ({ status: 1, stdout: '', stderr: 'failed' }),
    }
  );

  assert.equal(result.ok, false);
  assert.ok(result.error.includes('コメントの投稿に失敗'));
});

test('publishPlan: 空のリポジトリ名が返った場合はok:false', () => {
  const result = publishPlan(
    { issue: '42', body: '計画', workspace: '/tmp/ws' },
    {
      ghRepoViewFn: () => ({ status: 0, stdout: '\n', stderr: '' }),
    }
  );

  assert.equal(result.ok, false);
  assert.ok(result.error.includes('解決できません'));
});

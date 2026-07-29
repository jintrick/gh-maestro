'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { publishPlan } = require('../scripts/publish-plan');

test('publishPlan: pin済みコメントなし → 新規投稿してpinする', () => {
  let pinCalledWith = null;
  const result = publishPlan(
    { issue: '42', body: '# Plan\n\n内容', workspace: '/tmp/ws' },
    {
      ghRepoViewFn: () => ({ status: 0, stdout: 'owner/repo\n', stderr: '' }),
      ghListCommentsFn: () => ({ status: 0, stdout: '[]', stderr: '' }),
      ghCreateCommentFn: (issue, repo, body) => {
        assert.equal(issue, '42');
        assert.equal(repo, 'owner/repo');
        assert.equal(body, '# Plan\n\n内容');
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
  assert.equal(result.warning, undefined);
  assert.deepEqual(pinCalledWith, { commentId: 12345, repo: 'owner/repo' });
});

test('publishPlan: pin済みコメントあり → そのコメントを更新する（新規追加しない）', () => {
  let createCalled = false;
  let pinCalled = false;
  const pinnedComment = {
    id: 99999,
    body: '古い計画',
    html_url: 'https://github.com/owner/repo/issues/42#issuecomment-99999',
    pin: { pinned_at: '2026-01-01T00:00:00Z' },
  };
  const result = publishPlan(
    { issue: '42', body: '# 新しい計画', workspace: '/tmp/ws' },
    {
      ghRepoViewFn: () => ({ status: 0, stdout: 'owner/repo\n', stderr: '' }),
      ghListCommentsFn: () => ({ status: 0, stdout: JSON.stringify([
        { id: 1, body: '普通のコメント', pin: null },
        pinnedComment,
        { id: 2, body: '別のコメント', pin: null },
      ]), stderr: '' }),
      ghUpdateCommentFn: (commentId, repo, body) => {
        assert.equal(commentId, 99999);
        assert.equal(repo, 'owner/repo');
        assert.equal(body, '# 新しい計画');
        return { status: 0, stdout: JSON.stringify({ id: 99999, html_url: 'https://github.com/owner/repo/issues/42#issuecomment-99999', body: '# 新しい計画' }), stderr: '' };
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

test('publishPlan: コメントはあるがpin済みなし → 新規投稿してpin', () => {
  let pinCalledWith = null;
  const result = publishPlan(
    { issue: '7', body: '計画', workspace: '/tmp/ws' },
    {
      ghRepoViewFn: () => ({ status: 0, stdout: 'o/r\n', stderr: '' }),
      ghListCommentsFn: () => ({ status: 0, stdout: JSON.stringify([
        { id: 10, body: 'コメント1', pin: null },
        { id: 11, body: 'コメント2', pin: null },
      ]), stderr: '' }),
      ghCreateCommentFn: () => ({ status: 0, stdout: JSON.stringify({ id: 200, html_url: 'https://github.com/o/r/issues/7#issuecomment-200' }), stderr: '' }),
      ghPinCommentFn: (commentId, repo) => {
        pinCalledWith = { commentId, repo };
        return { status: 0, stdout: '', stderr: '' };
      },
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.action, 'created');
  assert.equal(result.url, 'https://github.com/o/r/issues/7#issuecomment-200');
  assert.deepEqual(pinCalledWith, { commentId: 200, repo: 'o/r' });
});

test('publishPlan: pin成功後にwarningなし', () => {
  const result = publishPlan(
    { issue: '1', body: '計画', workspace: '/tmp/ws' },
    {
      ghRepoViewFn: () => ({ status: 0, stdout: 'x/y\n', stderr: '' }),
      ghListCommentsFn: () => ({ status: 0, stdout: '[]', stderr: '' }),
      ghCreateCommentFn: () => ({ status: 0, stdout: JSON.stringify({ id: 1, html_url: 'https://github.com/x/y/issues/1#issuecomment-1' }), stderr: '' }),
      ghPinCommentFn: () => ({ status: 0, stdout: '', stderr: '' }),
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.warning, undefined);
});

test('publishPlan: pin失敗時はok:trueだがwarningが設定される', () => {
  const result = publishPlan(
    { issue: '1', body: '計画', workspace: '/tmp/ws' },
    {
      ghRepoViewFn: () => ({ status: 0, stdout: 'a/b\n', stderr: '' }),
      ghListCommentsFn: () => ({ status: 0, stdout: '[]', stderr: '' }),
      ghCreateCommentFn: () => ({ status: 0, stdout: JSON.stringify({ id: 3, html_url: 'https://github.com/a/b/issues/1#issuecomment-3' }), stderr: '' }),
      ghPinCommentFn: () => ({ status: 1, stdout: '', stderr: 'not found' }),
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.action, 'created');
  assert.equal(result.url, 'https://github.com/a/b/issues/1#issuecomment-3');
  assert.ok(result.warning.includes('pinに失敗'));
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

test('publishPlan: コメント一覧取得失敗時はok:false', () => {
  const result = publishPlan(
    { issue: '42', body: '計画', workspace: '/tmp/ws' },
    {
      ghRepoViewFn: () => ({ status: 0, stdout: 'o/r\n', stderr: '' }),
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
      ghListCommentsFn: () => ({ status: 0, stdout: '{"message":"error"}', stderr: '' }),
    }
  );

  assert.equal(result.ok, false);
  assert.ok(result.error.includes('形式が不正'));
});

test('publishPlan: 更新時のレスポンスにhtml_urlがない場合はok:false', () => {
  const result = publishPlan(
    { issue: '42', body: '計画', workspace: '/tmp/ws' },
    {
      ghRepoViewFn: () => ({ status: 0, stdout: 'o/r\n', stderr: '' }),
      ghListCommentsFn: () => ({ status: 0, stdout: JSON.stringify([{ id: 1, pin: {} }]), stderr: '' }),
      ghUpdateCommentFn: () => ({ status: 0, stdout: '{}', stderr: '' }),
    }
  );

  assert.equal(result.ok, false);
  assert.ok(result.error.includes('URLを抽出できません'));
});

test('publishPlan: 更新のgh api失敗時はok:false', () => {
  const result = publishPlan(
    { issue: '42', body: '計画', workspace: '/tmp/ws' },
    {
      ghRepoViewFn: () => ({ status: 0, stdout: 'o/r\n', stderr: '' }),
      ghListCommentsFn: () => ({ status: 0, stdout: JSON.stringify([{ id: 1, pin: {} }]), stderr: '' }),
      ghUpdateCommentFn: () => ({ status: 1, stdout: '', stderr: 'validation error' }),
    }
  );

  assert.equal(result.ok, false);
  assert.ok(result.error.includes('pin済みコメントの更新に失敗'));
});

test('publishPlan: 作成レスポンスからidを抽出できない場合はok:false', () => {
  const result = publishPlan(
    { issue: '42', body: '計画', workspace: '/tmp/ws' },
    {
      ghRepoViewFn: () => ({ status: 0, stdout: 'o/r\n', stderr: '' }),
      ghListCommentsFn: () => ({ status: 0, stdout: '[]', stderr: '' }),
      ghCreateCommentFn: () => ({ status: 0, stdout: JSON.stringify({ html_url: 'https://...' }), stderr: '' }),
    }
  );

  assert.equal(result.ok, false);
  assert.ok(result.error.includes('ID/URLを抽出できません'));
});

test('publishPlan: 作成のgh api失敗時はok:false', () => {
  const result = publishPlan(
    { issue: '42', body: '計画', workspace: '/tmp/ws' },
    {
      ghRepoViewFn: () => ({ status: 0, stdout: 'o/r\n', stderr: '' }),
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

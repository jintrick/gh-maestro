'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { publishPlan, PLAN_MARKER, parseCommentsResponse } = require('../scripts/publish-plan');

const MARKER = PLAN_MARKER;

// ── parseCommentsResponse ─────────────────────────────────────────────────





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

test('publishPlan: マーカー付きpin済みコメントあり → 更新する', () => {
  let createCalled = false;
  let pinCalled = false;
  const updateBody = MARKER + '\n# 新しい計画';
  const pinnedComment = {
    id: 99999,
    body: MARKER + '\n古い計画',
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
  };
  const result = publishPlan(
    { issue: '42', body: '計画', workspace: '/tmp/ws' },
    {
      ghRepoViewFn: () => ({ status: 0, stdout: 'o/r\n', stderr: '' }),
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

test('publishPlan: コメント一覧が--paginate --slurp形式でも正しく平坦化して検索する', () => {
  const pinnedPlan = {
    id: 500,
    body: MARKER + '\n既存計画',
    pin: { pinned_at: '2026-01-01T00:00:00Z' },
  };
  // --paginate --slurp は [[page1], [page2]] の形
  const paginated = JSON.stringify([
    [{ id: 1, body: 'コメント1', pin: null }],
    [pinnedPlan],
    [{ id: 2, body: 'コメント2', pin: null }],
  ]);
  const result = publishPlan(
    { issue: '42', body: '更新計画', workspace: '/tmp/ws' },
    {
      ghRepoViewFn: () => ({ status: 0, stdout: 'o/r\n', stderr: '' }),
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

test('publishPlan: 更新のgh api失敗時はok:false', () => {
  const result = publishPlan(
    { issue: '42', body: '計画', workspace: '/tmp/ws' },
    {
      ghRepoViewFn: () => ({ status: 0, stdout: 'o/r\n', stderr: '' }),
      ghListCommentsFn: () => ({ status: 0, stdout: JSON.stringify([{ id: 1, body: MARKER + '\nold', pin: {} }]), stderr: '' }),
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

function loadPublishPlanWithSpawn(fakeSpawnSync) {
  const cpPath = require.resolve('../scripts/shared/child-process');
  const gcPath = require.resolve('../scripts/shared/gh-comments');
  const ppPath = require.resolve('../scripts/publish-plan');
  const savedCp = require.cache[cpPath];
  const savedGc = require.cache[gcPath];
  const savedPp = require.cache[ppPath];
  require.cache[cpPath] = { id: cpPath, filename: cpPath, loaded: true, exports: { spawnSync: fakeSpawnSync } };
  delete require.cache[gcPath];
  delete require.cache[ppPath];
  try {
    return require(ppPath);
  } finally {
    if (savedCp) require.cache[cpPath] = savedCp; else delete require.cache[cpPath];
    if (savedGc) require.cache[gcPath] = savedGc; else delete require.cache[gcPath];
    if (savedPp) require.cache[ppPath] = savedPp; else delete require.cache[ppPath];
  }
}

test('publishPlan: 既定実装は 32KB超の日本語を含む計画本文でも新規投稿・更新ともに -F body=@- と stdin で渡し argv へ載せない', () => {
  const largePlan = '# 実装計画（日本語）\n' + '手順の詳細説明と受け入れ条件の検証手順。\n'.repeat(1200);
  const expectedBody = MARKER + '\n' + largePlan;
  assert.ok(Buffer.byteLength(expectedBody, 'utf8') > 32768, 'テスト前提: 32KB超の日本語計画本文');

  for (const mode of ['create', 'update']) {
    const calls = [];
    const fresh = loadPublishPlanWithSpawn((cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      if (args[0] === 'repo' && args[1] === 'view') {
        return { status: 0, stdout: 'owner/repo\n', stderr: '' };
      }
      if (args[0] === 'api' && args[1] === '--method' && args[2] === 'GET') {
        const list = mode === 'update'
          ? [{ id: 999, body: MARKER + '\n旧計画', pin: { pinned_at: '2026-01-01T00:00:00Z' } }]
          : [];
        return { status: 0, stdout: JSON.stringify(list), stderr: '' };
      }
      if (args[0] === 'api' && args[1] === '-X' && args[2] === 'PUT') {
        return { status: 0, stdout: '', stderr: '' };
      }
      return {
        status: 0,
        stdout: JSON.stringify({ id: mode === 'create' ? 555 : 999, html_url: 'https://github.com/owner/repo/issues/42#issuecomment-555' }),
        stderr: '',
      };
    });

    const res = fresh.publishPlan({ issue: '42', body: largePlan, workspace: '/tmp/ws' });
    assert.equal(res.ok, true, `${mode}: ${res.error}`);
    assert.equal(res.action, mode === 'create' ? 'created' : 'updated');

    const writeCall = calls.find(c => c.cmd === 'gh' && c.args.includes('-F') && c.args.includes('body=@-'));
    assert.ok(writeCall, `${mode}: -F body=@- でコメント投稿/更新を行う`);
    const expectedArgs = mode === 'create'
      ? ['api', 'repos/owner/repo/issues/42/comments', '-X', 'POST', '-F', 'body=@-']
      : ['api', '-X', 'PATCH', 'repos/owner/repo/issues/comments/999', '-F', 'body=@-'];
    assert.deepEqual(writeCall.args, expectedArgs);
    assert.ok(writeCall.args.join(' ').length < 256, 'argv に長文計画を含めない');
    assert.equal(writeCall.opts.encoding, 'utf8');
    assert.equal(writeCall.opts.input, expectedBody);
  }
});

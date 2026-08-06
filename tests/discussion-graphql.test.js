'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { _setGraphqlExec } = require('../scripts/shared/graphql-client');
const gql = require('../scripts/shared/discussion-graphql');

// ── helpers ────────────────────────────────────────────────────────────────────

// 実行された graphqlExec の args を記録し、任意の応答を返す注入ヘルパー
function capture(calls, response) {
  _setGraphqlExec((args, opts) => {
    calls.push({ args, opts });
    return { status: 0, stdout: JSON.stringify(response), stderr: '' };
  });
}

function okResponse(payload) {
  return { data: payload };
}

function errorResponse() {
  return { errors: [{ message: 'boom' }] };
}

afterEach(() => {
  _setGraphqlExec(undefined); // 実装の既定に戻す（次テストは必ず注入してから呼ぶ）
});

// ── hasDiscussionsEnabled ──────────────────────────────────────────────────────

test('hasDiscussionsEnabled: 有効なら true', () => {
  const calls = [];
  capture(calls, okResponse({ repository: { hasDiscussionsEnabled: true } }));
  assert.equal(gql.hasDiscussionsEnabled('acme/repo'), true);
  assert.ok(calls[0].args.some(a => a.includes('hasDiscussionsEnabled')));
});

test('hasDiscussionsEnabled: 無効なら false', () => {
  const calls = [];
  capture(calls, okResponse({ repository: { hasDiscussionsEnabled: false } }));
  assert.equal(gql.hasDiscussionsEnabled('acme/repo'), false);
});

test('hasDiscussionsEnabled: GraphQL errors は false（フェイルクローズ）', () => {
  const calls = [];
  capture(calls, errorResponse());
  assert.equal(gql.hasDiscussionsEnabled('acme/repo'), false);
});

test('hasDiscussionsEnabled: status 非0 は false（フェイルクローズ）', () => {
  _setGraphqlExec(() => ({ status: 1, stdout: '', stderr: 'gh: not authenticated' }));
  assert.equal(gql.hasDiscussionsEnabled('acme/repo'), false);
});

// ── discussionCategories ───────────────────────────────────────────────────────

test('discussionCategories: ノード一覧を返す', () => {
  const calls = [];
  capture(calls, okResponse({
    repository: { discussionCategories: { nodes: [
      { id: 'cat1', name: 'General' },
      { id: 'cat2', name: 'Ideas' },
    ] } },
  }));
  const cats = gql.discussionCategories('acme/repo');
  assert.deepEqual(cats, [
    { id: 'cat1', name: 'General' },
    { id: 'cat2', name: 'Ideas' },
  ]);
  assert.ok(calls[0].args.some(a => a.includes('discussionCategories')));
});

test('discussionCategories: 名前・ID欠落ノードは除外する', () => {
  capture([], okResponse({
    repository: { discussionCategories: { nodes: [
      { id: 'cat1', name: 'General' },
      { name: 'NoId' },
      { id: 'cat2' },
      null,
    ] } },
  }));
  const cats = gql.discussionCategories('acme/repo');
  assert.deepEqual(cats, [{ id: 'cat1', name: 'General' }]);
});

test('discussionCategories: 失敗時は空配列', () => {
  const calls = [];
  capture(calls, errorResponse());
  assert.deepEqual(gql.discussionCategories('acme/repo'), []);
});

test('discussionCategories: nodes 欠落は空配列', () => {
  capture([], okResponse({ repository: {} }));
  assert.deepEqual(gql.discussionCategories('acme/repo'), []);
});

// ── createDiscussion ───────────────────────────────────────────────────────────

test('createDiscussion: repository ID 解決後に mutation を実行して結果を返す', () => {
  const calls = [];
  // 1回目: repository { id } / 2回目: createDiscussion
  _setGraphqlExec((args) => {
    calls.push(args);
    if (args.some(a => a.includes('createDiscussion'))) {
      return { status: 0, stdout: JSON.stringify(okResponse({
        createDiscussion: { discussion: { id: 'D1', number: 12, url: 'https://github.com/acme/repo/discussions/12', title: '議題' } },
      })), stderr: '' };
    }
    return { status: 0, stdout: JSON.stringify(okResponse({ repository: { id: 'R_1' } })), stderr: '' };
  });

  const created = gql.createDiscussion('acme/repo', '議題', '本文', 'cat1');
  assert.deepEqual(created, {
    id: 'D1', number: 12, url: 'https://github.com/acme/repo/discussions/12', title: '議題',
  });

  // mutation 呼び出しは repositoryId / categoryId / title を -f で、body を stdin で渡す
  const mutationArgs = calls.find(a => a.some(x => x.includes('createDiscussion')));
  assert.ok(mutationArgs.includes('repositoryId=R_1'));
  assert.ok(mutationArgs.includes('categoryId=cat1'));
  assert.ok(mutationArgs.includes('title=議題'));
  assert.ok(mutationArgs.includes('body=@-'));
});

test('createDiscussion: 本文は opts.input で渡される', () => {
  let input;
  _setGraphqlExec((args, opts) => {
    input = opts.input;
    if (args.some(a => a.includes('createDiscussion'))) {
      return { status: 0, stdout: JSON.stringify(okResponse({
        createDiscussion: { discussion: { id: 'D1', number: 1, url: 'u', title: 't' } },
      })), stderr: '' };
    }
    return { status: 0, stdout: JSON.stringify(okResponse({ repository: { id: 'R_1' } })), stderr: '' };
  });
  gql.createDiscussion('acme/repo', '議題', '本文body', 'cat1');
  assert.equal(input, '本文body');
});

test('createDiscussion: repository ID が取れない場合は null', () => {
  capture([], okResponse({ repository: null }));
  assert.equal(gql.createDiscussion('acme/repo', '議題', '本文', 'cat1'), null);
});

test('createDiscussion: mutation が errors を返したら null', () => {
  _setGraphqlExec((args) => {
    if (args.some(a => a.includes('createDiscussion'))) {
      return { status: 0, stdout: JSON.stringify(errorResponse()), stderr: '' };
    }
    return { status: 0, stdout: JSON.stringify(okResponse({ repository: { id: 'R_1' } })), stderr: '' };
  });
  assert.equal(gql.createDiscussion('acme/repo', '議題', '本文', 'cat1'), null);
});

test('createDiscussion: 応答に discussion 欠落なら null', () => {
  _setGraphqlExec((args) => {
    if (args.some(a => a.includes('createDiscussion'))) {
      return { status: 0, stdout: JSON.stringify(okResponse({})), stderr: '' };
    }
    return { status: 0, stdout: JSON.stringify(okResponse({ repository: { id: 'R_1' } })), stderr: '' };
  });
  assert.equal(gql.createDiscussion('acme/repo', '議題', '本文', 'cat1'), null);
});

// ── addDiscussionComment ───────────────────────────────────────────────────────

test('addDiscussionComment: コメント URL を返す', () => {
  const calls = [];
  capture(calls, okResponse({
    addDiscussionComment: { comment: { id: 'C1', url: 'https://github.com/acme/repo/discussions/12#comment-1' } },
  }));
  const url = gql.addDiscussionComment('D1', 'コメント本文');
  assert.equal(url, 'https://github.com/acme/repo/discussions/12#comment-1');

  const args = calls[0].args;
  assert.ok(args.includes('id=D1'));
  assert.ok(args.includes('body=@-'));
});

test('addDiscussionComment: 本文は opts.input で渡される', () => {
  let input;
  _setGraphqlExec((args, opts) => {
    input = opts.input;
    return { status: 0, stdout: JSON.stringify(okResponse({
      addDiscussionComment: { comment: { id: 'C1', url: 'u' } },
    })), stderr: '' };
  });
  gql.addDiscussionComment('D1', 'コメントbody');
  assert.equal(input, 'コメントbody');
});

test('addDiscussionComment: GraphQL errors は null', () => {
  capture([], errorResponse());
  assert.equal(gql.addDiscussionComment('D1', '本文'), null);
});

test('addDiscussionComment: URL 欠落は null', () => {
  capture([], okResponse({ addDiscussionComment: { comment: {} } }));
  assert.equal(gql.addDiscussionComment('D1', '本文'), null);
});

// ── discussion ─────────────────────────────────────────────────────────────────

test('discussion: 復元用のメタデータを返す', () => {
  const calls = [];
  capture(calls, okResponse({
    repository: { discussion: { id: 'D1', number: 12, url: 'https://github.com/acme/repo/discussions/12', title: '議題' } },
  }));
  const d = gql.discussion('acme/repo', 12);
  assert.deepEqual(d, { id: 'D1', number: 12, url: 'https://github.com/acme/repo/discussions/12', title: '議題' });
  assert.ok(calls[0].args.includes('num=12'));
});

test('discussion: 存在しない場合は null', () => {
  capture([], okResponse({ repository: { discussion: null } }));
  assert.equal(gql.discussion('acme/repo', 999), null);
});

test('discussion: GraphQL errors は null', () => {
  capture([], errorResponse());
  assert.equal(gql.discussion('acme/repo', 12), null);
});

// ── クエリ文字列の構造妥当性 ────────────────────────────────────────────────────

/**
 * クエリ文字列で使用されているのに宣言されていない GraphQL 変数を抽出する。
 * graphqlExec はクエリ文字列をそのまま gh に渡すため、宣言漏れは実行時に
 * variableNotDefined エラーになる。stub で graphqlExec を差し替えていると
 * 実行時の検出がスリップするため、文字列自体を構造検証する（review指摘 #1）。
 */
function undeclaredVariables(query) {
  const sig = query.match(/^\s*(?:query|mutation)\s*(?:\(([^)]*)\))?/);
  const declared = new Set();
  if (sig && sig[1]) {
    for (const m of sig[1].matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) declared.add(m[1]);
  }
  const used = new Set();
  for (const m of query.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (!declared.has(m[1])) used.add(m[1]);
  }
  return [...used].sort();
}

test('undeclaredVariables: 宣言漏れ変数を検出する（検証が空振りでないこと）', () => {
  // 本指摘の既知バグ形（$num を使用しているのに宣言していない）を検出できる
  assert.deepEqual(
    undeclaredVariables('query($owner:String!){repository(owner:$owner){discussion(number:$num){id}}}'),
    ['num']
  );
});

test('discussion: クエリ文字列は使用変数をすべて宣言している（GraphQLとして妥当）', () => {
  const calls = [];
  capture(calls, okResponse({
    repository: { discussion: { id: 'D1', number: 12, url: 'u', title: 't' } },
  }));
  gql.discussion('acme/repo', 12);
  const query = calls[0].args.find(a => a.startsWith('query=')).slice('query='.length);
  // number に渡す変数 $num が Int! として宣言されている
  assert.match(query, /query\(\$owner:String!,\$name:String!,\$num:Int!\)/);
  assert.deepEqual(undeclaredVariables(query), []);
});

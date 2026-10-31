'use strict';

// PR コメントのテスト申告表（scripts/shared/pr-declaration.js）の形式・HEAD照合・取得・投稿を
// 固定する（Issue #671）。gh は listCommentsFn / spawnSyncFn の注入で差し替え、実プロセスを起動しない。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  DECLARATION_MARKER_PREFIX,
  buildDeclarationComment,
  findDeclarationForHead,
  readPrDeclarationEvidence,
  upsertDeclarationComment,
} = require('../scripts/shared/pr-declaration');

const HEAD = '0123456789abcdef0123456789abcdef01234567';
const OTHER_HEAD = 'fedcba9876543210fedcba9876543210fedcba98';
const TABLE = '| テスト | 何が壊れたら失敗するか |\n|---|---|\n| t1 | 欠陥X |';
const MARKER = `<!-- ${DECLARATION_MARKER_PREFIX} head=${HEAD} -->`;

const trusted = (overrides) => ({ author_association: 'OWNER', ...overrides });

test('buildDeclarationComment: 先頭行にHEADのマーカー、続けて申告表を置く', () => {
  assert.equal(buildDeclarationComment(HEAD, `\n${TABLE}\n`), `${MARKER}\n${TABLE}\n`);
});

test('buildDeclarationComment: SHAが40桁の小文字16進でなければ、空の申告表なら拒否する', () => {
  assert.throws(() => buildDeclarationComment('abc', TABLE), /40桁/);
  assert.throws(() => buildDeclarationComment(HEAD.toUpperCase(), TABLE), /40桁/);
  assert.throws(() => buildDeclarationComment(HEAD, '  \n'), /空/);
});

test('findDeclarationForHead: 同じHEADの信頼される申告表だけを、最新のものから返す', () => {
  const comments = [
    { id: 1, body: `${MARKER}\n旧表`, author_association: 'OWNER' },
    { id: 2, body: `<!-- ${DECLARATION_MARKER_PREFIX} head=${OTHER_HEAD} -->\n別HEAD`, author_association: 'OWNER' },
    { id: 3, body: `${MARKER}\n偽物`, author_association: 'NONE' },
    { id: 4, body: '普通のコメント', author_association: 'OWNER' },
    { id: 5, body: `${MARKER}\n${TABLE}`, author_association: 'MEMBER', html_url: 'https://example/5' },
  ];
  const found = findDeclarationForHead(comments, HEAD);
  assert.deepEqual(found, { commentId: 5, table: TABLE, url: 'https://example/5' });
  assert.equal(findDeclarationForHead([comments[1], comments[2], comments[3]], HEAD), null);
});

test('readPrDeclarationEvidence: 一致するHEADの申告表があれば present、無ければ absent', () => {
  const listed = (comments) => () => ({ status: 0, stdout: JSON.stringify(comments) });
  assert.deepEqual(
    readPrDeclarationEvidence({ pr: 5, repo: 'o/r', headSha: HEAD, listCommentsFn: listed([trusted({ id: 9, body: `${MARKER}\n${TABLE}` })]) }),
    { status: 'present', head: HEAD, table: TABLE },
  );
  assert.deepEqual(
    readPrDeclarationEvidence({ pr: 5, repo: 'o/r', headSha: HEAD, listCommentsFn: listed([]) }),
    { status: 'absent', head: HEAD },
  );
});

test('readPrDeclarationEvidence: 取得できない・不正な入力は unavailable（黙って absent にしない）', () => {
  const failing = () => ({ status: 1, stdout: '', stderr: 'gh failed' });
  const throwing = () => { throw new Error('spawn failed'); };
  const notArray = () => ({ status: 0, stdout: '{"message":"Not Found"}' });
  for (const listCommentsFn of [failing, throwing, notArray]) {
    const result = readPrDeclarationEvidence({ pr: 5, repo: 'o/r', headSha: HEAD, listCommentsFn });
    assert.equal(result.status, 'unavailable', JSON.stringify(result));
  }
  const badSha = readPrDeclarationEvidence({ pr: 5, repo: 'o/r', headSha: 'xyz', listCommentsFn: () => ({ status: 0, stdout: '[]' }) });
  assert.equal(badSha.status, 'unavailable');
});

test('upsertDeclarationComment: 同じHEADの既存コメントが無ければ新規投稿、あれば PATCH で更新する', () => {
  const calls = [];
  const spawnSyncFn = (cmd, args) => { calls.push({ cmd, args }); return { status: 0, stdout: '{"html_url":"https://example/new"}' }; };
  const empty = () => ({ status: 0, stdout: '[]' });
  const created = upsertDeclarationComment({ pr: 5, repo: 'o/r', headSha: HEAD, table: TABLE, listCommentsFn: empty, spawnSyncFn });
  assert.deepEqual(created, { ok: true, action: 'created', url: 'https://example/new' });
  assert.deepEqual(calls[0].args.slice(0, 2), ['api', 'repos/o/r/issues/5/comments']);

  const existing = () => ({ status: 0, stdout: JSON.stringify([trusted({ id: 77, body: `${MARKER}\n旧表` })]) });
  calls.length = 0;
  const updated = upsertDeclarationComment({ pr: 5, repo: 'o/r', headSha: HEAD, table: TABLE, listCommentsFn: existing, spawnSyncFn });
  assert.equal(updated.action, 'updated');
  assert.deepEqual(calls[0].args.slice(0, 4), ['api', '-X', 'PATCH', 'repos/o/r/issues/comments/77']);
});

test('upsertDeclarationComment: 投稿に失敗したら ok:false を返す（例外にしない）', () => {
  const result = upsertDeclarationComment({
    pr: 5, repo: 'o/r', headSha: HEAD, table: TABLE,
    listCommentsFn: () => ({ status: 0, stdout: '[]' }),
    spawnSyncFn: () => ({ status: 1, stdout: '', stderr: 'boom' }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /投稿に失敗/);
});

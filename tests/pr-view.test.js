'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parsePrViewResponse,
  parsePrHeadResponse,
  readPrHead,
} = require('../scripts/shared/pr-view');

test('parsePrViewResponse はquery-test-statusで使うコメント・HEAD・authorを共有して読む', () => {
  assert.deepEqual(parsePrViewResponse(JSON.stringify({
    comments: [{ id: 'comment-1' }],
    headRefOid: 'a'.repeat(40),
    author: { login: 'owner' },
  })), {
    ok: true,
    comments: [{ id: 'comment-1' }],
    headSha: 'a'.repeat(40),
    prAuthor: 'owner',
  });
});

test('parsePrHeadResponse は有効なHEADだけを成功として返す', () => {
  assert.deepEqual(parsePrHeadResponse(JSON.stringify({ headRefOid: 'a'.repeat(40) })), {
    ok: true,
    headSha: 'a'.repeat(40),
  });
  assert.equal(parsePrHeadResponse(JSON.stringify({})).ok, false);
  assert.equal(parsePrHeadResponse(JSON.stringify({ headRefOid: 'not-a-sha' })).ok, false);
  assert.equal(parsePrHeadResponse('{invalid').ok, false);
});

test('readPrHead は取得成功とGitHub・応答失敗を判別する', () => {
  const success = readPrHead('42', 'owner/project', {
    ghPrViewFn: (pr, repo) => {
      assert.equal(pr, '42');
      assert.equal(repo, 'owner/project');
      return { status: 0, stdout: JSON.stringify({ headRefOid: 'b'.repeat(40) }) };
    },
  });
  assert.deepEqual(success, { ok: true, headSha: 'b'.repeat(40) });

  const ghFailure = readPrHead('42', 'owner/project', {
    ghPrViewFn: () => ({ status: 1, stderr: 'API unavailable' }),
  });
  assert.equal(ghFailure.ok, false);
  assert.match(ghFailure.error, /API unavailable/);

  const thrownFailure = readPrHead('42', 'owner/project', {
    ghPrViewFn: () => { throw new Error('gh spawn failed'); },
  });
  assert.equal(thrownFailure.ok, false);
  assert.match(thrownFailure.error, /gh spawn failed/);

  const malformed = readPrHead('42', 'owner/project', {
    ghPrViewFn: () => ({ status: 0, stdout: JSON.stringify({ headRefOid: 123 }) }),
  });
  assert.equal(malformed.ok, false);
  assert.match(malformed.error, /headRefOid/);
});

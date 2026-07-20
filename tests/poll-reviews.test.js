'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isValidCommentId } = require('../scripts/poll-reviews.js');

test('isValidCommentId: 正の整数IDだけを受理する', () => {
  assert.equal(isValidCommentId('12345'), true);
  assert.equal(isValidCommentId('1'), true);
});

test('isValidCommentId: GitHubエラーレスポンス由来のゴミ断片を弾く', () => {
  // 実障害: GitHub障害中に 404 JSON や切れた出力の断片が state 記録・中継された
  assert.equal(isValidCommentId('}'), false);
  assert.equal(isValidCommentId(''), false);
  assert.equal(isValidCommentId('{"message": "Not Found"'), false);
  assert.equal(isValidCommentId('  '), false);
  assert.equal(isValidCommentId('12a'), false);
  assert.equal(isValidCommentId('-1'), false);
});

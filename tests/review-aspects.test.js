'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ALL_LEAF_IDS,
  reviewFilesForLeaves,
} = require('../scripts/shared/review-aspects');

test('reviewFilesForLeaves: 共通ファイルと担当葉のpre/postだけを導出する', () => {
  const leafIds = ['correctness/api-contract', 'test-quality/test-quality'];
  assert.deepEqual(reviewFilesForLeaves(leafIds), [
    'common.md',
    'correctness/api-contract/pre-review.md',
    'correctness/api-contract/post-review.md',
    'test-quality/test-quality/pre-review.md',
    'test-quality/test-quality/post-review.md',
  ]);
});

test('reviewFilesForLeaves: 未知の葉IDはファイルパスへ変換せず拒否する', () => {
  assert.throws(() => reviewFilesForLeaves(['correctness/unknown']), /unknown leaf id/);
  assert.throws(() => reviewFilesForLeaves(['../outside']), /unknown leaf id/);
  assert.throws(() => reviewFilesForLeaves([]), /leaf_ids must be a non-empty array/);
});


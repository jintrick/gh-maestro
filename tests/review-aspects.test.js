'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ALL_LEAF_IDS,
  REVIEW_ASPECT_FILES,
  deriveLeafFilePath,
  reviewFilesForLeaves,
} = require('../scripts/shared/review-aspects');

test('deriveLeafFilePath: 正規の7葉はIDから正本相対パスへ導出できる', () => {
  assert.deepEqual(
    ALL_LEAF_IDS.map(deriveLeafFilePath),
    ALL_LEAF_IDS.map(id => `${id}/${REVIEW_ASPECT_FILES.pre}`),
  );
});

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

test('deriveLeafFilePath: 未知の葉IDはパスへ変換せず拒否する', () => {
  assert.throws(
    () => deriveLeafFilePath('correctness/replaced-by-pr-content'),
    /unknown leaf id/,
  );
  assert.throws(
    () => deriveLeafFilePath('../outside'),
    /unknown leaf id/,
  );
  assert.throws(
    () => deriveLeafFilePath(null),
    /unknown leaf id/,
  );
});

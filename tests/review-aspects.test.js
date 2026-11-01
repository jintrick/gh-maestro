'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ALL_LEAF_IDS,
  TRUNK_TO_LEAVES,
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

test('TRUNK_TO_LEAVES: 全葉は正確に1つの幹に属する（幹への登録漏れ・重複を検出する）', () => {
  // 期待値は ALL_LEAF_IDS と TRUNK_TO_LEAVES の独立した2つの定義を突き合わせる。
  // 葉を幹へ登録し忘れると、finalize のゲートが黙ってその葉を検査しなくなる。
  const flattened = Object.values(TRUNK_TO_LEAVES).flat();
  assert.deepEqual([...flattened].sort(), [...ALL_LEAF_IDS].sort());
});

test('reviewFilesForLeaves: 未知の葉IDはファイルパスへ変換せず拒否する', () => {
  assert.throws(() => reviewFilesForLeaves(['correctness/unknown']), /unknown leaf id/);
  assert.throws(() => reviewFilesForLeaves(['../outside']), /unknown leaf id/);
  assert.throws(() => reviewFilesForLeaves([]), /leaf_ids must be a non-empty array/);
});


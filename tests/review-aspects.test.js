'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ALL_LEAF_IDS,
  deriveLeafFilePath,
} = require('../scripts/shared/review-aspects');

test('deriveLeafFilePath: 正規の7葉はIDから正本相対パスへ導出できる', () => {
  assert.deepEqual(
    ALL_LEAF_IDS.map(deriveLeafFilePath),
    ALL_LEAF_IDS.map(id => `${id}.md`),
  );
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

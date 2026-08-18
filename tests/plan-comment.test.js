'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  PLAN_MARKER,
  isPlanComment,
  findPlanComments,
  stripPlanMarker,
} = require('../scripts/shared/plan-comment');

test('PLAN_MARKER: 定数値が正しい', () => {
  assert.equal(PLAN_MARKER, '<!-- gh-maestro-plan:v1 -->');
});

test('isPlanComment: pin済みかつマーカーありはtrue', () => {
  const comment = {
    id: 1,
    body: `${PLAN_MARKER}\n# 計画本文`,
    pin: { pinned_at: '2026-01-01T00:00:00Z' },
  };
  assert.equal(isPlanComment(comment), true);
});

test('isPlanComment: pinなしはfalse', () => {
  const comment = {
    id: 2,
    body: `${PLAN_MARKER}\n# 計画本文`,
    pin: null,
  };
  assert.equal(isPlanComment(comment), false);
});

test('isPlanComment: pin済みだがマーカーなしはfalse', () => {
  const comment = {
    id: 3,
    body: '# 計画ではないメモ',
    pin: { pinned_at: '2026-01-01T00:00:00Z' },
  };
  assert.equal(isPlanComment(comment), false);
});

test('isPlanComment: null / undefined / 不正オブジェクトはfalse', () => {
  assert.equal(isPlanComment(null), false);
  assert.equal(isPlanComment(undefined), false);
  assert.equal(isPlanComment({}), false);
  assert.equal(isPlanComment({ pin: {} }), false);
  assert.equal(isPlanComment({ pin: {}, body: 123 }), false);
});

test('findPlanComments: 該当コメントのみを抽出する', () => {
  const comments = [
    { id: 1, body: '通常コメント', pin: null },
    { id: 2, body: `${PLAN_MARKER}\n計画1`, pin: { pinned_at: '2026-01-01' } },
    { id: 3, body: '他目的pin', pin: { pinned_at: '2026-01-01' } },
    { id: 4, body: `${PLAN_MARKER}\n未pin計画`, pin: null },
    { id: 5, body: `${PLAN_MARKER}\n計画2`, pin: { pinned_at: '2026-01-02' } },
  ];
  const found = findPlanComments(comments);
  assert.equal(found.length, 2);
  assert.equal(found[0].id, 2);
  assert.equal(found[1].id, 5);
});

test('findPlanComments: 非配列入力には空配列を返す', () => {
  assert.deepEqual(findPlanComments(null), []);
  assert.deepEqual(findPlanComments(undefined), []);
  assert.deepEqual(findPlanComments('invalid'), []);
});

test('stripPlanMarker: 先頭行のPLAN_MARKERを除去する', () => {
  const body = `${PLAN_MARKER}\n# 計画見出し\n内容本文`;
  assert.equal(stripPlanMarker(body), '# 計画見出し\n内容本文');
});

test('stripPlanMarker: マーカーがない本文はそのまま返す', () => {
  const body = '# 計画見出し\n内容本文';
  assert.equal(stripPlanMarker(body), '# 計画見出し\n内容本文');
});

test('stripPlanMarker: 空文字やnull/undefinedの処理', () => {
  assert.equal(stripPlanMarker(''), '');
  assert.equal(stripPlanMarker(null), '');
  assert.equal(stripPlanMarker(undefined), '');
});

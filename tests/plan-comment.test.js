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

test('isPlanComment: 1行目が単独マーカーかつpin済みならtrue', () => {
  const comment = {
    id: 1,
    body: `${PLAN_MARKER}\n# 計画本文`,
    pin: { pinned_at: '2026-01-01T00:00:00Z' },
  };
  assert.equal(isPlanComment(comment), true);
});

test('isPlanComment: 1行目単独マーカーのみ（本文なし）でもtrue', () => {
  const comment = {
    id: 1,
    body: PLAN_MARKER,
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

test('isPlanComment: 1行目の途中にマーカーがある場合はfalse（否定ケース）', () => {
  const commentPrefix = {
    id: 4,
    body: `前置テキスト ${PLAN_MARKER}\n# 計画`,
    pin: { pinned_at: '2026-01-01T00:00:00Z' },
  };
  assert.equal(isPlanComment(commentPrefix), false);

  const commentSuffix = {
    id: 5,
    body: `${PLAN_MARKER} 後置テキスト\n# 計画`,
    pin: { pinned_at: '2026-01-01T00:00:00Z' },
  };
  assert.equal(isPlanComment(commentSuffix), false);
});

test('isPlanComment: 2行目以降にマーカーがある場合はfalse（引用・言及の否定ケース）', () => {
  const quoted = {
    id: 6,
    body: `> ${PLAN_MARKER}\n> # 引用された計画\nこれに対するコメント`,
    pin: { pinned_at: '2026-01-01T00:00:00Z' },
  };
  assert.equal(isPlanComment(quoted), false);

  const inBody = {
    id: 7,
    body: `# 計画の概要\n以下にマーカーを含む: ${PLAN_MARKER}`,
    pin: { pinned_at: '2026-01-01T00:00:00Z' },
  };
  assert.equal(isPlanComment(inBody), false);
});

test('isPlanComment: null / undefined / 不正オブジェクトはfalse', () => {
  assert.equal(isPlanComment(null), false);
  assert.equal(isPlanComment(undefined), false);
  assert.equal(isPlanComment({}), false);
  assert.equal(isPlanComment({ pin: {} }), false);
  assert.equal(isPlanComment({ pin: {}, body: 123 }), false);
});

test('findPlanComments: 該当コメントのみを抽出する（引用や途中マーカーを除外）', () => {
  const comments = [
    { id: 1, body: '通常コメント', pin: null },
    { id: 2, body: `${PLAN_MARKER}\n計画1`, pin: { pinned_at: '2026-01-01' } },
    { id: 3, body: '他目的pin', pin: { pinned_at: '2026-01-01' } },
    { id: 4, body: `${PLAN_MARKER}\n未pin計画`, pin: null },
    { id: 5, body: `> ${PLAN_MARKER}\n引用計画`, pin: { pinned_at: '2026-01-02' } },
    { id: 6, body: `${PLAN_MARKER}\n計画2`, pin: { pinned_at: '2026-01-03' } },
  ];
  const found = findPlanComments(comments);
  assert.equal(found.length, 2);
  assert.equal(found[0].id, 2);
  assert.equal(found[1].id, 6);
});

test('findPlanComments: 非配列入力には空配列を返す', () => {
  assert.deepEqual(findPlanComments(null), []);
  assert.deepEqual(findPlanComments(undefined), []);
  assert.deepEqual(findPlanComments('invalid'), []);
});

test('stripPlanMarker: 先頭行の単独PLAN_MARKERを除去する', () => {
  const body = `${PLAN_MARKER}\n# 計画見出し\n内容本文`;
  assert.equal(stripPlanMarker(body), '# 計画見出し\n内容本文');
});

test('stripPlanMarker: 1行目の途中にマーカーがある場合は除去しない', () => {
  const body = `prefix ${PLAN_MARKER}\n# 計画見出し\n内容本文`;
  assert.equal(stripPlanMarker(body), `prefix ${PLAN_MARKER}\n# 計画見出し\n内容本文`);
});

test('stripPlanMarker: 2行目以降にマーカーがある場合は除去しない', () => {
  const body = `> ${PLAN_MARKER}\n# 計画見出し`;
  assert.equal(stripPlanMarker(body), `> ${PLAN_MARKER}\n# 計画見出し`);
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

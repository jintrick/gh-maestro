'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeWorkerEntry } = require('../scripts/worker-entry');

test('normalizeWorkerEntry: 新形式 { paneId, agentId } をそのまま読む', () => {
  const r = normalizeWorkerEntry({ paneId: '42', agentId: 'agy' });
  assert.deepEqual(r, { paneId: '42', agentId: 'agy' });
});

test('normalizeWorkerEntry: 旧形式（pane_id文字列のみ）を後方互換で読む', () => {
  const r = normalizeWorkerEntry('42');
  assert.deepEqual(r, { paneId: '42', agentId: null });
});

test('normalizeWorkerEntry: agentId未設定の新形式は agentId: null になる', () => {
  const r = normalizeWorkerEntry({ paneId: '42' });
  assert.deepEqual(r, { paneId: '42', agentId: null });
});

test('normalizeWorkerEntry: undefined は paneId: null を返す', () => {
  const r = normalizeWorkerEntry(undefined);
  assert.deepEqual(r, { paneId: null, agentId: null });
});

test('normalizeWorkerEntry: 数値のpane_idも文字列化する', () => {
  const r = normalizeWorkerEntry(42);
  assert.deepEqual(r, { paneId: '42', agentId: null });
});

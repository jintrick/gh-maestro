'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeWorkerEntry, normalizePid } = require('../scripts/shared/worker-entry');

const EMPTY = {
  pid: null, startTime: null, logPath: null,
  agentId: null, issue: null, skill: null, baseBranch: null,
  paneId: null, notifierPid: null,
};

// ── 新形式（headless: pid/startTime/logPath） ────────────────────────────────

test('normalizeWorkerEntry: 新形式 { pid, startTime, logPath, agentId } をそのまま読む', () => {
  const r = normalizeWorkerEntry({
    pid: 4242, startTime: '2026-07-25T00:00:00.000Z', logPath: 'C:/ws/.gh-maestro/worker-logs/w.log', agentId: 'agy',
  });
  assert.deepEqual(r, {
    ...EMPTY,
    pid: 4242, startTime: '2026-07-25T00:00:00.000Z', logPath: 'C:/ws/.gh-maestro/worker-logs/w.log', agentId: 'agy',
  });
});

test('normalizeWorkerEntry: 文字列のpidも数値化する', () => {
  assert.equal(normalizeWorkerEntry({ pid: '4242' }).pid, 4242);
});

test('normalizeWorkerEntry: 不正なpid（0・負数・非数・小数）は null にする', () => {
  // 不正PIDのままkillや生存判定に使うと無関係なプロセスを対象にしうる
  for (const bad of [0, -1, 'abc', 1.5, {}, [], true, null, undefined]) {
    assert.equal(normalizeWorkerEntry({ pid: bad }).pid, null, `pid=${JSON.stringify(bad)}`);
  }
});

test('normalizeWorkerEntry: startTime/logPath は文字列でなければ null にする', () => {
  const r = normalizeWorkerEntry({ pid: 1, startTime: 12345, logPath: { a: 1 } });
  assert.equal(r.startTime, null);
  assert.equal(r.logPath, null);
});

test('normalizeWorkerEntry: issue を数値化して保持する（文字列で渡されても Number() される）', () => {
  assert.equal(normalizeWorkerEntry({ pid: 1, issue: '51' }).issue, 51);
});

test('normalizeWorkerEntry: skill を保持する', () => {
  const r = normalizeWorkerEntry({ pid: 1, agentId: 'claude-ds', issue: 7, skill: 'gh-maestro-coder' });
  assert.equal(r.skill, 'gh-maestro-coder');
  assert.equal(r.agentId, 'claude-ds');
});

test('normalizeWorkerEntry: baseBranch を保持する（resume時のGH_MAESTRO_BASE_BRANCH再注入に使う）', () => {
  const r = normalizeWorkerEntry({ pid: 1, baseBranch: 'dev' });
  assert.equal(r.baseBranch, 'dev');
});

test('normalizeWorkerEntry: baseBranch は空文字・非文字列なら null にする', () => {
  assert.equal(normalizeWorkerEntry({ pid: 1, baseBranch: '' }).baseBranch, null);
  assert.equal(normalizeWorkerEntry({ pid: 1, baseBranch: 123 }).baseBranch, null);
  assert.equal(normalizeWorkerEntry({ pid: 1, baseBranch: null }).baseBranch, null);
  // レガシーレコード（baseBranch 未設定）も null に正規化される
  assert.equal(normalizeWorkerEntry({ pid: 1 }).baseBranch, null);
});

// ── レガシー形式（移行前セッションの掃除にのみ使う） ─────────────────────────

test('normalizeWorkerEntry: レガシー paneId を読める（移行前セッションの掃除に必要）', () => {
  const r = normalizeWorkerEntry({ paneId: '42', agentId: 'agy' });
  assert.deepEqual(r, { ...EMPTY, paneId: '42', agentId: 'agy' });
});

test('normalizeWorkerEntry: 最旧形式（pane_id文字列のみ）を後方互換で読む', () => {
  assert.deepEqual(normalizeWorkerEntry('42'), { ...EMPTY, paneId: '42' });
});

test('normalizeWorkerEntry: 数値のpane_idも文字列化する', () => {
  assert.deepEqual(normalizeWorkerEntry(42), { ...EMPTY, paneId: '42' });
});

test('normalizeWorkerEntry: notifierPid を保持する（レガシーnotifierのkillに必要）', () => {
  assert.equal(normalizeWorkerEntry({ paneId: '42', notifierPid: 1234 }).notifierPid, 1234);
});

test('normalizeWorkerEntry: undefined は全フィールド null を返す', () => {
  assert.deepEqual(normalizeWorkerEntry(undefined), EMPTY);
});

// ── normalizePid ─────────────────────────────────────────────────────────────

test('normalizePid: 正の整数のみ受け付ける', () => {
  assert.equal(normalizePid(1), 1);
  assert.equal(normalizePid('4242'), 4242);
  assert.equal(normalizePid(0), null);
  assert.equal(normalizePid(-5), null);
  assert.equal(normalizePid(3.14), null);
  assert.equal(normalizePid('x'), null);
  assert.equal(normalizePid(null), null);
});

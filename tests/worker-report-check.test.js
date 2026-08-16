'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  hasReportedSinceStart,
  getLatestReportSinceStart,
  formatElapsedTime,
} = require('../scripts/shared/worker-report-check');

function marker({ to = 'orchestrator', from }) {
  return `<!-- gh-maestro {"v":1,"to":"${to}","from":"${from}"} -->\n> hello`;
}

test('startTime以降に自分自身からの報告があれば true', () => {
  const comments = [
    { id: 1, created_at: '2026-01-01T00:05:00Z', body: marker({ from: 'issue-9-fix' }) },
  ];
  assert.equal(hasReportedSinceStart(comments, 'issue-9-fix', '2026-01-01T00:00:00.000Z'), true);
});

test('報告コメントが無ければ false', () => {
  assert.equal(hasReportedSinceStart([], 'issue-9-fix', '2026-01-01T00:00:00.000Z'), false);
});

test('起動時刻より前の報告（前回セッションの古い報告）は無視して false', () => {
  const comments = [
    { id: 1, created_at: '2025-12-31T23:59:00Z', body: marker({ from: 'issue-9-fix' }) },
  ];
  assert.equal(hasReportedSinceStart(comments, 'issue-9-fix', '2026-01-01T00:00:00.000Z'), false);
});

test('別ワーカーからの報告は対象外で false', () => {
  const comments = [
    { id: 1, created_at: '2026-01-01T00:05:00Z', body: marker({ from: 'issue-9-other' }) },
  ];
  assert.equal(hasReportedSinceStart(comments, 'issue-9-fix', '2026-01-01T00:00:00.000Z'), false);
});

test('宛先がorchestrator以外の報告（他ワーカー宛の転送・言及等）は対象外で false', () => {
  const comments = [
    { id: 1, created_at: '2026-01-01T00:05:00Z', body: marker({ to: 'issue-9-other', from: 'issue-9-fix' }) },
  ];
  assert.equal(hasReportedSinceStart(comments, 'issue-9-fix', '2026-01-01T00:00:00.000Z'), false);
});

test('マーカーが無いコメントは無視される', () => {
  const comments = [
    { id: 1, created_at: '2026-01-01T00:05:00Z', body: '普通のコメント' },
  ];
  assert.equal(hasReportedSinceStart(comments, 'issue-9-fix', '2026-01-01T00:00:00.000Z'), false);
});

test('startTimeが無ければ null（判定不能）', () => {
  const comments = [
    { id: 1, created_at: '2026-01-01T00:05:00Z', body: marker({ from: 'issue-9-fix' }) },
  ];
  assert.equal(hasReportedSinceStart(comments, 'issue-9-fix', null), null);
  assert.equal(hasReportedSinceStart(comments, 'issue-9-fix', undefined), null);
});

test('startTimeが不正な文字列（Dateでパース不能）なら null（判定不能）', () => {
  const comments = [
    { id: 1, created_at: '2026-01-01T00:05:00Z', body: marker({ from: 'issue-9-fix' }) },
  ];
  assert.equal(hasReportedSinceStart(comments, 'issue-9-fix', 'old'), null);
});

test('commentsが配列でなければ null（判定不能）', () => {
  assert.equal(hasReportedSinceStart(null, 'issue-9-fix', '2026-01-01T00:00:00.000Z'), null);
  assert.equal(hasReportedSinceStart(undefined, 'issue-9-fix', '2026-01-01T00:00:00.000Z'), null);
});

// ミリ秒精度(startTime) vs 秒精度(GitHub created_at) の文字列比較誤判定対策
// （.claude/rules/process-lifecycle-scripts.md）。
// startTime は端数（ミリ秒/ナノ秒相当）を持つが、GitHub の created_at は秒精度で端数が無い。
// ASCIIでは '.' < 'Z' のため、同一秒内では「端数あり」の文字列は常に「端数無し」の文字列より
// 辞書順で小さいと判定される。よって素朴な文字列比較は、同一秒内の任意のコメントを常に
// 「起動より後（=報告済み）」と誤判定する。数値化してから比較すればこの誤りを引き継がない。
test('起動時刻に秒未満の端数があっても、素朴な文字列比較の誤りを引き継がない', () => {
  const comments = [
    { id: 1, created_at: '2026-01-01T00:00:05Z', body: marker({ from: 'issue-9-fix' }) },
  ];
  const naiveStringComparisonResult = '2026-01-01T00:00:05Z' >= '2026-01-01T00:00:05.900Z';
  assert.equal(naiveStringComparisonResult, true, '素朴な文字列比較は誤ってtrueになる（この誤りの実例）');
  assert.equal(hasReportedSinceStart(comments, 'issue-9-fix', '2026-01-01T00:00:05.900Z'), false,
    '数値化した比較では誤って報告済みと判定しない');
});

test('created_atが無いコメントは無視される', () => {
  const comments = [
    { id: 1, body: marker({ from: 'issue-9-fix' }) },
  ];
  assert.equal(hasReportedSinceStart(comments, 'issue-9-fix', '2026-01-01T00:00:00.000Z'), false);
});

test('getLatestReportSinceStart: 複数の報告がある場合は最新のコメントを返す', () => {
  const comments = [
    { id: 1, created_at: '2026-01-01T00:02:00Z', body: marker({ from: 'issue-9-fix' }) },
    { id: 2, created_at: '2026-01-01T00:05:00Z', body: marker({ from: 'issue-9-fix' }) },
    { id: 3, created_at: '2026-01-01T00:03:00Z', body: marker({ from: 'issue-9-fix' }) },
  ];
  const latest = getLatestReportSinceStart(comments, 'issue-9-fix', '2026-01-01T00:00:00.000Z');
  assert.equal(latest?.id, 2);
});

test('getLatestReportSinceStart: 該当報告が無ければ null を返す', () => {
  const comments = [
    { id: 1, created_at: '2025-12-31T23:59:00Z', body: marker({ from: 'issue-9-fix' }) },
  ];
  const latest = getLatestReportSinceStart(comments, 'issue-9-fix', '2026-01-01T00:00:00.000Z');
  assert.equal(latest, null);
});

test('getLatestReportSinceStart: 不正な引数は null を返す', () => {
  assert.equal(getLatestReportSinceStart(null, 'issue-9-fix', '2026-01-01T00:00:00.000Z'), null);
  assert.equal(getLatestReportSinceStart([], 'issue-9-fix', null), null);
  assert.equal(getLatestReportSinceStart([], 'issue-9-fix', 'invalid-date'), null);
});

test('formatElapsedTime: 各種秒数・分数・時間数を人間可読にフォーマットする', () => {
  const base = new Date('2026-01-01T00:00:00.000Z').getTime();

  // 秒のみ
  assert.equal(formatElapsedTime(base, base), '0秒');
  assert.equal(formatElapsedTime(base, base + 3000), '3秒');
  assert.equal(formatElapsedTime(base, base + 59000), '59秒');

  // 分秒
  assert.equal(formatElapsedTime(base, base + 60000), '1分0秒');
  assert.equal(formatElapsedTime(base, base + 312000), '5分12秒');
  assert.equal(formatElapsedTime(base, base + 3599000), '59分59秒');

  // 時間分秒
  assert.equal(formatElapsedTime(base, base + 3600000), '1時間0分0秒');
  assert.equal(formatElapsedTime(base, base + 3723000), '1時間2分3秒');
  assert.equal(formatElapsedTime(base, base + 90605000), '25時間10分5秒');

  // 負の差分（逆転）は0秒に丸める
  assert.equal(formatElapsedTime(base + 5000, base), '0秒');

  // 不正値は0秒
  assert.equal(formatElapsedTime('invalid', base), '0秒');
  assert.equal(formatElapsedTime(base, 'invalid'), '0秒');
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// finalize-council.js は外部プロセスを起動しない（投稿・state書き出しは注入関数）。
// 純粋関数（集計・要約生成）と注入つきの finalizeCouncil を検証する。

const m = require('../scripts/finalize-council.js');

const ORDER = ['alpha', 'beta', 'gamma'];

// ── tallyVotes ────────────────────────────────────────────────────────────────

test('tallyVotes: choice を支持票・agrees_with を賛同票として集計する', () => {
  const votes = [
    { participant_id: 'beta', choice: 'alpha', rationale: 'r1', agrees_with: ['alpha'] },
    { participant_id: 'gamma', choice: 'alpha', rationale: 'r2' },
    { participant_id: 'alpha', choice: 'gamma', rationale: 'r3', agrees_with: ['beta'] },
  ];
  const t = m.tallyVotes({ votes, participantOrder: ORDER });

  const byId = Object.fromEntries(t.entries.map((e) => [e.participant_id, e]));
  assert.equal(byId.alpha.supportVotes, 2);
  assert.equal(byId.alpha.agreeVotes, 1);
  assert.deepEqual(byId.alpha.voters, ['beta', 'gamma']);
  assert.equal(byId.gamma.supportVotes, 1);
  assert.equal(byId.gamma.agreeVotes, 0);
  assert.deepEqual(byId.beta.supportVotes, 0);
  assert.equal(t.totalVotes, 3);
});

test('tallyVotes: 支持票数の降順でソートする', () => {
  const votes = [
    { participant_id: 'alpha', choice: 'beta', rationale: 'r' },
    { participant_id: 'beta', choice: 'alpha', rationale: 'r' },
  ];
  const t = m.tallyVotes({ votes, participantOrder: ORDER });
  assert.equal(t.entries[0].participant_id, 'alpha'); // 1票
  assert.equal(t.entries[1].participant_id, 'beta');  // 1票
  assert.equal(t.entries[2].participant_id, 'gamma'); // 0票
});

test('tallyVotes: 同票はグループ定義順（participantOrder）で安定', () => {
  // 全員0票: alpha, beta, gamma の定義順のまま
  const t = m.tallyVotes({ votes: [], participantOrder: ORDER });
  assert.deepEqual(t.entries.map((e) => e.participant_id), ORDER);
  assert.deepEqual(t.entries.map((e) => e.rank), [1, 2, 3]);
});

test('tallyVotes: 同票でも支持票の多い順が優先され、順位は連番', () => {
  const votes = [
    { participant_id: 'alpha', choice: 'beta', rationale: 'r' },
    { participant_id: 'gamma', choice: 'beta', rationale: 'r' },
    { participant_id: 'beta', choice: 'alpha', rationale: 'r' },
  ];
  const t = m.tallyVotes({ votes, participantOrder: ORDER });
  assert.equal(t.entries[0].participant_id, 'beta');  // 2票
  assert.equal(t.entries[0].rank, 1);
  assert.equal(t.entries[1].participant_id, 'alpha'); // 1票
  assert.equal(t.entries[1].rank, 2);
  assert.equal(t.entries[2].participant_id, 'gamma'); // 0票
  assert.equal(t.entries[2].rank, 3);
});

test('tallyVotes: participantOrder に無い choice は無視する', () => {
  const votes = [
    { participant_id: 'alpha', choice: 'ghost', rationale: 'r' },
    { participant_id: 'beta', choice: 'ghost', rationale: 'r' },
  ];
  const t = m.tallyVotes({ votes, participantOrder: ORDER });
  assert.equal(t.totalVotes, 2);
  assert.ok(t.entries.every((e) => e.supportVotes === 0));
});

test('tallyVotes: 空配列・participantOrder 省略でも壊れない', () => {
  const t1 = m.tallyVotes({ votes: [], participantOrder: ORDER });
  assert.equal(t1.entries.length, 3);
  const t2 = m.tallyVotes({ votes: [] });
  assert.deepEqual(t2.entries, []);
});

// ── opinionCommentBody / voteCommentBody ──────────────────────────────────────

test('opinionCommentBody: 意見・stance・key_points・risks を含む', () => {
  const body = m.opinionCommentBody({
    participant_id: 'alpha',
    opinion: '採用すべき。',
    stance: 'AGREE',
    key_points: ['p1', 'p2'],
    risks: ['r1'],
  });
  assert.ok(body.includes('意見（alpha）'));
  assert.ok(body.includes('採用すべき。'));
  assert.ok(body.includes('stance: AGREE'));
  assert.ok(body.includes('key_points: p1 / p2'));
  assert.ok(body.includes('risks: r1'));
});

test('voteCommentBody: choice・rationale・agrees_with を含む', () => {
  const body = m.voteCommentBody({
    participant_id: 'beta',
    choice: 'alpha',
    rationale: '理由',
    agrees_with: ['alpha', 'gamma'],
  });
  assert.ok(body.includes('投票（beta）'));
  assert.ok(body.includes('choice: alpha'));
  assert.ok(body.includes('rationale: 理由'));
  assert.ok(body.includes('agrees_with: alpha, gamma'));
});

// ── buildSummaryMarkdown ──────────────────────────────────────────────────────

function sampleSummary(overrides = {}) {
  const order = ORDER;
  const votes = [
    { participant_id: 'beta', choice: 'alpha', rationale: 'r1', agrees_with: ['alpha'] },
    { participant_id: 'gamma', choice: 'alpha', rationale: 'r2' },
  ];
  const tally = m.tallyVotes({ votes, participantOrder: order });
  return m.buildSummaryMarkdown({
    title: 'RAG構成の採用可否',
    now: '2026-08-06T00:00:00Z',
    participantOrder: order,
    opinions: [
      { participant_id: 'alpha', opinion: 'o1', stance: 'AGREE', commentUrl: 'http://x/c1' },
    ],
    votes: votes.map((v, i) => ({ ...v, commentUrl: `http://x/c${i + 2}` })),
    tally,
    absentees: [{ participant_id: 'delta', phase: 'opinion', reason: 'agent exited with code 1' }],
    discussionUrl: 'http://x/disc',
    ...overrides,
  });
}

test('buildSummaryMarkdown: 議題・開催日・参加モデルを記載する', () => {
  const s = sampleSummary();
  assert.ok(s.includes('RAG構成の採用可否'));
  assert.ok(s.includes('2026-08-06T00:00:00Z'));
  assert.ok(s.includes('alpha, beta, gamma'));
});

test('buildSummaryMarkdown: 意見コメントへのリンクと投票テーブル・ランキングを含む', () => {
  const s = sampleSummary();
  assert.ok(s.includes('[コメント](http://x/c1)'));
  assert.ok(s.includes('| alpha | 2 | 1 | beta, gamma |'));
  assert.ok(s.includes('1. **alpha**（支持 2票 / 賛同 1票）'));
  assert.ok(s.includes('**beta** → alpha: r1'));
});

test('buildSummaryMarkdown: 欠席・失敗した参加者を必ず明記する', () => {
  const s = sampleSummary();
  assert.ok(s.includes('欠席・失敗した参加者'));
  assert.ok(s.includes('**delta**（opinion）: agent exited with code 1'));
});

test('buildSummaryMarkdown: 欠席者が居なくても「なし」と明記する（必須項目）', () => {
  const s = sampleSummary({ absentees: [] });
  assert.ok(s.includes('欠席・失敗した参加者'));
  assert.ok(s.includes('- なし'));
});

test('buildSummaryMarkdown: Discussion URL を記載する', () => {
  const s = sampleSummary();
  assert.ok(s.includes('http://x/disc'));
});

test('buildSummaryMarkdown: 意見が無ければ「意見なし」を記載する', () => {
  const s = sampleSummary({ opinions: [] });
  assert.ok(s.includes('（意見なし）'));
});

// ── finalizeCouncil ───────────────────────────────────────────────────────────

test('finalizeCouncil: 意見・投票・要約を投稿し complete state を書き出す', async () => {
  const posted = [];
  let written = null;
  const state = await m.finalizeCouncil({
    title: 'T',
    now: '2026-08-06T00:00:00Z',
    session: 's1',
    participantOrder: ['alpha', 'beta'],
    opinions: [{ participant_id: 'alpha', opinion: 'o1', stance: 'AGREE' }],
    votes: [{ participant_id: 'beta', choice: 'alpha', rationale: 'r' }],
    absentees: [],
    discussionUrl: 'http://x/disc',
    postComment: async (body) => { posted.push(body); return `http://x/c${posted.length}`; },
    writeState: async (s) => { written = s; },
  });

  assert.equal(posted.length, 3); // 意見 + 投票 + 要約
  assert.equal(state.status, 'complete');
  assert.equal(state.opinions[0].commentUrl, 'http://x/c1');
  assert.equal(state.votes[0].commentUrl, 'http://x/c2');
  assert.equal(state.summaryCommentUrl, 'http://x/c3');
  assert.equal(state.tally.entries.length, 2);
  assert.equal(written.status, 'complete');
  assert.equal(written.summaryCommentUrl, 'http://x/c3');
  // 要約コメント本文が最後に投稿されている
  assert.ok(posted[2].includes('council 要約'));
});

test('finalizeCouncil: スキーマ違反の投票はフェイルクローズ（投稿せず throw）', async () => {
  let posted = 0;
  await assert.rejects(
    m.finalizeCouncil({
      title: 'T',
      now: 'x',
      session: 's1',
      participantOrder: ['a'],
      votes: [{ participant_id: 'b', choice: 'a' }], // rationale 欠落
      discussionUrl: 'u',
      postComment: async () => { posted++; return 'u'; },
      writeState: async () => {},
    }),
    /vote schema validation failed/,
  );
  assert.equal(posted, 0);
});

test('finalizeCouncil: 意見が無くても投稿・集計・state書き出しが成立する', async () => {
  let written = null;
  const state = await m.finalizeCouncil({
    title: 'T',
    now: 'x',
    session: 's1',
    participantOrder: ['alpha'],
    votes: [],
    absentees: [{ participant_id: 'alpha', phase: 'opinion', reason: 'r' }],
    discussionUrl: 'u',
    postComment: async (body) => `url:${body.length}`,
    writeState: async (s) => { written = s; },
  });
  assert.equal(state.status, 'complete');
  assert.equal(state.tally.totalVotes, 0);
  assert.equal(written.absentees.length, 1);
});

test('finalizeCouncil: 投稿成功ごとに finalize チェックポイントを永続化する', async () => {
  const posted = [];
  const writes = [];
  await m.finalizeCouncil({
    title: 'T',
    now: 'x',
    session: 's1',
    participantOrder: ['alpha', 'beta'],
    opinions: [
      { participant_id: 'alpha', opinion: 'o1', stance: 'AGREE' },
      { participant_id: 'beta', opinion: 'o2', stance: 'DISAGREE' },
    ],
    votes: [{ participant_id: 'alpha', choice: 'beta', rationale: 'r' }],
    absentees: [],
    discussionUrl: 'u',
    postComment: async (body) => { posted.push(body); return `http://x/c${posted.length}`; },
    writeState: async (s) => { writes.push(JSON.parse(JSON.stringify(s))); },
  });

  // 意見2件＋投票1件＋要約1件 = 4回投稿、投稿後のチェックポイント永続化が4回
  assert.equal(posted.length, 4);
  // 意見1件目投稿後に永続化された state.finalize は意見1件のみ
  assert.deepEqual(writes[0].finalize.opinions.map((o) => o.participant_id), ['alpha']);
  assert.equal(writes[0].finalize.votes.length, 0);
  assert.equal(writes[0].finalize.summaryCommentUrl, null);
  // 意見2件目投稿後
  assert.deepEqual(writes[1].finalize.opinions.map((o) => o.participant_id), ['alpha', 'beta']);
  // 投票投稿後
  assert.deepEqual(writes[2].finalize.votes.map((v) => v.participant_id), ['alpha']);
  assert.ok(writes[2].finalize.opinions.every((o) => o.commentUrl));
  // 要約投稿後
  assert.ok(writes[3].finalize.summaryCommentUrl.startsWith('http://x/c'));
  // 最終 state は complete
  assert.equal(writes[writes.length - 1].status, 'complete');
});

test('finalizeCouncil: resume時は finalized の投稿済み項目を再投稿しない', async () => {
  const posted = [];
  const state = await m.finalizeCouncil({
    title: 'T',
    now: 'x',
    session: 's1',
    participantOrder: ['alpha', 'beta'],
    opinions: [
      { participant_id: 'alpha', opinion: 'o1', stance: 'AGREE' },
      { participant_id: 'beta', opinion: 'o2', stance: 'DISAGREE' },
    ],
    votes: [{ participant_id: 'alpha', choice: 'beta', rationale: 'r' }],
    absentees: [],
    discussionUrl: 'u',
    // 途中まで完了した finalize チェックポイント（意見alpha・投票は済み、意見beta・要約が未投稿）
    finalized: {
      opinions: [{ participant_id: 'alpha', opinion: 'o1', stance: 'AGREE', commentUrl: 'http://x/c1' }],
      votes: [{ participant_id: 'alpha', choice: 'beta', rationale: 'r', commentUrl: 'http://x/c2' }],
      summaryCommentUrl: null,
    },
    postComment: async (body) => { posted.push(body); return `http://x/r${posted.length}`; },
    writeState: async () => {},
  });

  // 未投稿分のみ: 意見beta + 要約 = 2件
  assert.equal(posted.length, 2);
  assert.ok(posted[0].includes('意見（beta）'));
  assert.ok(posted[1].includes('council 要約'));
  // 投稿済みの commentUrl はチェックポイントから引き継がれる
  assert.equal(state.opinions.find((o) => o.participant_id === 'alpha').commentUrl, 'http://x/c1');
  assert.equal(state.votes[0].commentUrl, 'http://x/c2');
  assert.ok(state.summaryCommentUrl.startsWith('http://x/r'));
});

test('finalizeCouncil: resume時に要約も投稿済みなら追加投稿なし', async () => {
  const posted = [];
  const state = await m.finalizeCouncil({
    title: 'T',
    now: 'x',
    session: 's1',
    participantOrder: ['alpha'],
    opinions: [{ participant_id: 'alpha', opinion: 'o1', stance: 'AGREE' }],
    votes: [{ participant_id: 'alpha', choice: 'alpha', rationale: 'r' }],
    absentees: [],
    discussionUrl: 'u',
    finalized: {
      opinions: [{ participant_id: 'alpha', opinion: 'o1', stance: 'AGREE', commentUrl: 'http://x/c1' }],
      votes: [{ participant_id: 'alpha', choice: 'alpha', rationale: 'r', commentUrl: 'http://x/c2' }],
      summaryCommentUrl: 'http://x/c3',
    },
    postComment: async (body) => { posted.push(body); return 'never'; },
    writeState: async () => {},
  });
  assert.equal(posted.length, 0);
  assert.equal(state.summaryCommentUrl, 'http://x/c3');
});

// ── buildStoppedState ─────────────────────────────────────────────────────────

test('buildStoppedState: 停止状態の shape を返す', () => {
  const s = m.buildStoppedState({
    session: 's1',
    title: 'T',
    phase: 'opinion',
    stoppedAt: '2026-08-06T00:00:00Z',
    failures: [{ participant_id: 'a', attempt: 1, error: 'agent exit 1' }],
  });
  assert.equal(s.status, 'stopped');
  assert.equal(s.phase, 'opinion');
  assert.equal(s.failures.length, 1);
});

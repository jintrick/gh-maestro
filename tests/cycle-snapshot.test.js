'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { postCycleSnapshot, METRICS_LABEL, markerFor } = require('../scripts/shared/cycle-snapshot');
const { recordMergeAndSnapshot } = require('../scripts/poll-pr');

function metrics() {
  return {
    totalSeconds: 3720,
    intervals: [
      { key: 'preparation', label: '準備', seconds: 240, recorded: true },
      { key: 'planning', label: '計画', seconds: 540, recorded: true },
      { key: 'approval', label: '承認', seconds: 1920, recorded: true },
      { key: 'implementation', label: '実装', seconds: 360, recorded: true },
      { key: 'review', label: '査読', seconds: 660, recorded: true },
      { key: 'integration', label: '統合', seconds: null, recorded: false },
    ],
    workers: [{
      role: 'senior-coder', runNumber: 1, agentId: 'codex-luna-max',
      elapsedSeconds: 720, running: false, pid: 16924,
    }],
  };
}

test('postCycleSnapshot: ラベル検索・必要時の作成・投稿先と本文を渡す', () => {
  const calls = { search: [], create: [], comments: [], post: [], released: 0 };
  const result = postCycleSnapshot({ issue: 450, pr: 99, repo: 'o/r', workspace: 'C:/workspace', metrics: metrics() }, {
    acquireLockFn: () => true,
    releaseLockFn: () => { calls.released++; },
    listMetricsIssuesFn: (args) => {
      calls.search.push(args);
      return { status: 0, stdout: '\n', stderr: '' };
    },
    createMetricsIssueFn: (args) => {
      calls.create.push(args);
      return { status: 0, stdout: '77\n', stderr: '' };
    },
    listCommentsFn: (repo, issue, opts) => {
      calls.comments.push({ repo, issue, opts });
      return { status: 0, stdout: '[]', stderr: '' };
    },
    postCommentFn: (args) => {
      calls.post.push(args);
      return { ok: true, url: 'https://github.com/o/r/issues/77#issuecomment-1' };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(calls.released, 1);
  assert.deepEqual(calls.search[0], { repo: 'o/r', workspace: 'C:/workspace', label: METRICS_LABEL });
  assert.equal(calls.create[0].label, METRICS_LABEL);
  assert.deepEqual(calls.comments[0], { repo: 'o/r', issue: '77', opts: { cwd: 'C:/workspace' } });
  assert.equal(calls.post[0].issue, '77');
  assert.equal(calls.post[0].repo, 'o/r');
  assert.match(calls.post[0].body, new RegExp(markerFor(450, 99).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(calls.post[0].body, /準備/);
  assert.match(calls.post[0].body, /senior-coder/);
  assert.match(calls.post[0].body, /codex-luna-max/);
});

test('postCycleSnapshot: 同じPRのマーカーがあれば二重投稿しない', () => {
  let postCalls = 0;
  let released = 0;
  const result = postCycleSnapshot({ issue: 450, pr: 99, repo: 'o/r', workspace: 'C:/workspace', metrics: metrics() }, {
    acquireLockFn: () => true,
    releaseLockFn: () => { released++; },
    listMetricsIssuesFn: () => ({ status: 0, stdout: '77\n' }),
    listCommentsFn: () => ({ status: 0, stdout: JSON.stringify([{ body: `old\n${markerFor(450, 99)}` }]) }),
    postCommentFn: () => { postCalls++; return { ok: true }; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.duplicate, true);
  assert.equal(postCalls, 0);
  assert.equal(released, 1);
});

test('postCycleSnapshot: 投稿失敗は失敗結果に隔離しロックを解放する', () => {
  let released = 0;
  const result = postCycleSnapshot({ issue: 450, pr: 99, repo: 'o/r', workspace: 'C:/workspace', metrics: metrics() }, {
    acquireLockFn: () => true,
    releaseLockFn: () => { released++; },
    listMetricsIssuesFn: () => ({ status: 0, stdout: '77\n' }),
    listCommentsFn: () => ({ status: 0, stdout: '[]' }),
    postCommentFn: ({ issue, body }) => ({ ok: false, error: `post ${issue} failed for ${body.length}` }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /post 77 failed/);
  assert.equal(released, 1);
});

test('recordMergeAndSnapshot: MERGEDだけがIssue/PRを打刻と投稿へ渡し、子の終了コードを変えない', () => {
  const events = [];
  const snapshots = [];
  const merged = recordMergeAndSnapshot({
    prState: 'MERGED', issue: '450', pr: '99', repo: 'o/r', workspace: 'C:/workspace', exitCode: 7,
  }, {
    recordCycleEventFn: (...args) => events.push(args),
    postCycleSnapshotFn: (args) => snapshots.push(args),
  });
  assert.equal(merged.merged, true);
  assert.equal(merged.exitCode, 7);
  assert.deepEqual(events, [['C:/workspace', '450', 'merged', { pr: '99' }]]);
  assert.deepEqual(snapshots, [{ issue: '450', pr: '99', repo: 'o/r', workspace: 'C:/workspace' }]);

  const closed = recordMergeAndSnapshot({
    prState: 'CLOSED', issue: '450', pr: '99', repo: 'o/r', workspace: 'C:/workspace', exitCode: 0,
  }, {
    recordCycleEventFn: () => { throw new Error('must not record'); },
    postCycleSnapshotFn: () => { throw new Error('must not post'); },
  });
  assert.equal(closed.merged, false);
});

test('recordMergeAndSnapshot: 打刻失敗でもスナップショット投稿とMERGED結果を保持する', () => {
  const calls = [];
  const result = recordMergeAndSnapshot({
    prState: 'MERGED', issue: '450', pr: '99', repo: 'o/r', workspace: 'C:/workspace', exitCode: 7,
  }, {
    recordCycleEventFn: () => { throw new Error('record failed'); },
    postCycleSnapshotFn: (args) => { calls.push(args); },
  });

  assert.equal(result.merged, true);
  assert.equal(result.exitCode, 7);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { issue: '450', pr: '99', repo: 'o/r', workspace: 'C:/workspace' });
  assert.match(result.warnings.join('\n'), /merged event: record failed/);
});

test('recordMergeAndSnapshot: スナップショット失敗でも打刻とMERGED結果を保持する', () => {
  const events = [];
  const result = recordMergeAndSnapshot({
    prState: 'MERGED', issue: '450', pr: '99', repo: 'o/r', workspace: 'C:/workspace', exitCode: 0,
  }, {
    recordCycleEventFn: (...args) => { events.push(args); },
    postCycleSnapshotFn: () => { throw new Error('post failed'); },
  });

  assert.equal(result.merged, true);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(events, [['C:/workspace', '450', 'merged', { pr: '99' }]]);
  assert.match(result.warnings.join('\n'), /cycle snapshot: post failed/);
});

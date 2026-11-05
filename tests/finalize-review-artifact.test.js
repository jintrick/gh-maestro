'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { withTempDir } = require('../scripts/shared/temp-directory');

const {
  cleanupIssueArtifacts,
  defaultFindReviewPrs,
  defaultFindReviewResultPosted,
  formatReviewArtifactLines,
  finalizeIssue,
} = require('../scripts/finalize-issue.js');

const ARTIFACT_BODY = '{"pr":7,"repo":"owner/repo","headRefOid":"abc","findings":[]}';

// 期待する印は、テスト内で仕様どおりに組み立てる（実装の reviewResultMarker を呼ばない）。
function expectedMarker(pr, bytes) {
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  return `<!-- gh-maestro:review-manager-result:v1:pr=${pr}:sha256=${sha} -->`;
}

function withWorkspaceWithArtifact(fn) {
  return withTempDir('gh-maestro-review-artifact-', (dir) => {
    const reviewDir = path.join(dir, '.gh-maestro', 'records', 'pr', '7', 'review');
    fs.mkdirSync(reviewDir, { recursive: true });
    const artifactPath = path.join(reviewDir, 'manager.json');
    fs.writeFileSync(artifactPath, ARTIFACT_BODY);
    return fn({ dir, artifactPath });
  });
}

test('cleanup removes manager.json only when the marker is confirmed as posted', () => {
  withWorkspaceWithArtifact(({ dir, artifactPath }) => {
    const seen = [];
    const result = cleanupIssueArtifacts(dir, 5, {
      repo: 'owner/repo',
      findReviewPrsFn: () => [7],
      findReviewResultPostedFn: (params) => {
        seen.push(params.marker);
        return { posted: true };
      },
    });
    assert.deepEqual(seen, [expectedMarker(7, ARTIFACT_BODY)]);
    assert.equal(fs.existsSync(artifactPath), false);
    assert.deepEqual(result.reviewArtifacts, [{ pr: 7, action: 'removed' }]);
  });
});

test('cleanup keeps manager.json when the marker is not found on the PR', () => {
  withWorkspaceWithArtifact(({ dir, artifactPath }) => {
    const result = cleanupIssueArtifacts(dir, 5, {
      findReviewPrsFn: () => [7],
      findReviewResultPostedFn: () => ({ posted: false }),
    });
    assert.equal(fs.existsSync(artifactPath), true);
    assert.equal(result.reviewArtifacts.length, 1);
    assert.equal(result.reviewArtifacts[0].action, 'kept');
    assert.match(result.reviewArtifacts[0].reason, /掲載の印が PR のレビューに見つかりません/);
  });
});

test('cleanup keeps manager.json and reports the reason when the posted check throws', () => {
  withWorkspaceWithArtifact(({ dir, artifactPath }) => {
    const result = cleanupIssueArtifacts(dir, 5, {
      findReviewPrsFn: () => [7],
      findReviewResultPostedFn: () => { throw new Error('gh api が失敗しました'); },
    });
    assert.equal(fs.existsSync(artifactPath), true);
    assert.equal(result.reviewArtifacts[0].action, 'kept');
    assert.match(result.reviewArtifacts[0].reason, /掲載を照合できません: gh api が失敗しました/);
  });
});

test('cleanup keeps manager.json when the posted check returns a non-boolean', () => {
  withWorkspaceWithArtifact(({ dir, artifactPath }) => {
    const result = cleanupIssueArtifacts(dir, 5, {
      findReviewPrsFn: () => [7],
      findReviewResultPostedFn: () => ({ posted: 'yes' }),
    });
    assert.equal(fs.existsSync(artifactPath), true);
    assert.equal(result.reviewArtifacts[0].action, 'kept');
  });
});

test('cleanup keeps manager.json and records a kept line when PR detection fails', () => {
  withWorkspaceWithArtifact(({ dir, artifactPath }) => {
    let postedCalled = false;
    const result = cleanupIssueArtifacts(dir, 5, {
      findReviewPrsFn: () => { throw new Error('gh pr list が失敗しました'); },
      findReviewResultPostedFn: () => { postedCalled = true; return { posted: true }; },
    });
    assert.equal(postedCalled, false, 'posted check must not run without a detected PR');
    assert.equal(fs.existsSync(artifactPath), true);
    assert.equal(result.reviewArtifacts.length, 1);
    assert.equal(result.reviewArtifacts[0].pr, null);
    assert.equal(result.reviewArtifacts[0].action, 'kept');
    assert.match(result.reviewArtifacts[0].reason, /PRを特定できない.*gh pr list が失敗しました/);
  });
});

test('cleanup does nothing when manager.json does not exist', () => {
  withTempDir('gh-maestro-review-artifact-none-', (dir) => {
    fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
    let postedCalled = false;
    const result = cleanupIssueArtifacts(dir, 5, {
      findReviewPrsFn: () => [7],
      findReviewResultPostedFn: () => { postedCalled = true; return { posted: true }; },
    });
    assert.equal(postedCalled, false);
    assert.deepEqual(result.reviewArtifacts, []);
  });
});

test('formatReviewArtifactLines prints machine-readable removed and kept lines', () => {
  assert.deepEqual(formatReviewArtifactLines([
    { pr: 7, action: 'removed' },
    { pr: 8, action: 'kept', reason: '掲載の印が\n見つかりません' },
    { pr: null, action: 'kept', reason: 'PR特定失敗' },
  ]), [
    'REVIEW_ARTIFACT_REMOVED:pr=7',
    'REVIEW_ARTIFACT_KEPT:pr=8 reason=掲載の印が 見つかりません',
    'REVIEW_ARTIFACT_KEPT:pr=? reason=PR特定失敗',
  ]);
});

test('finalizeIssue keeps manager.json when the decision cannot be posted (no cleanup runs)', () => {
  withWorkspaceWithArtifact(({ dir, artifactPath }) => {
    const result = finalizeIssue({ workspace: dir, issue: 5, decisionBody: '決定' }, {
      findDecisionPostedFn: () => ({ posted: false }),
      postDecisionFn: () => ({ ok: false, stderr: 'boom' }),
      findReviewPrsFn: () => [7],
      findReviewResultPostedFn: () => ({ posted: true }),
    });
    assert.equal(result.artifacts, null);
    assert.equal(fs.existsSync(artifactPath), true);
  });
});

test('defaultFindReviewResultPosted matches only the authenticated user with the marker', () => {
  const marker = '<!-- gh-maestro:review-manager-result:v1:pr=7:sha256=ff -->';
  const reviews = [
    { login: 'someone-else', body: `Review Manager completed.\n\n${marker}` },
    { login: 'Orchestrator', body: `Review Manager completed.\n\n${marker}` },
  ];
  const encodedLines = (items) => items.map((item) => `${Buffer.from(JSON.stringify(item)).toString('base64')}`).join('\n');
  const calls = [];
  const spawnSyncFn = (command, args) => {
    calls.push(args);
    if (args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: 'orchestrator\n', stderr: '' };
    if (args.includes('repos/owner/repo/pulls/7/reviews')) return { status: 0, stdout: encodedLines(reviews), stderr: '' };
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };
  const resolveRepoFn = () => ({ ok: true, repo: 'owner/repo' });

  assert.deepEqual(
    defaultFindReviewResultPosted({ pr: 7, repo: 'owner/repo', workspace: '/tmp/ws', marker }, { spawnSyncFn, resolveRepoFn }),
    { posted: true },
  );

  const otherMarker = '<!-- gh-maestro:review-manager-result:v1:pr=7:sha256=00 -->';
  assert.deepEqual(
    defaultFindReviewResultPosted({ pr: 7, repo: 'owner/repo', workspace: '/tmp/ws', marker: otherMarker }, { spawnSyncFn, resolveRepoFn }),
    { posted: false },
  );
});

test('defaultFindReviewResultPosted reports false when only other users posted the marker', () => {
  const marker = '<!-- gh-maestro:review-manager-result:v1:pr=7:sha256=ff -->';
  const spawnSyncFn = (command, args) => {
    if (args[1] === 'user') return { status: 0, stdout: 'orchestrator\n', stderr: '' };
    return { status: 0, stdout: `${Buffer.from(JSON.stringify({ login: 'bot', body: marker })).toString('base64')}\n`, stderr: '' };
  };
  assert.deepEqual(
    defaultFindReviewResultPosted({ pr: 7, repo: 'owner/repo', workspace: '/tmp/ws', marker }, {
      spawnSyncFn,
      resolveRepoFn: () => ({ ok: true, repo: 'owner/repo' }),
    }),
    { posted: false },
  );
});

test('defaultFindReviewResultPosted throws when the authenticated user cannot be read', () => {
  const spawnSyncFn = () => ({ status: 1, stdout: '', stderr: 'auth failed' });
  assert.throws(() => defaultFindReviewResultPosted(
    { pr: 7, repo: 'owner/repo', workspace: '/tmp/ws', marker: 'm' },
    { spawnSyncFn, resolveRepoFn: () => ({ ok: true, repo: 'owner/repo' }) },
  ), /GitHub認証ユーザーの取得に失敗しました/);
});

test('defaultFindReviewResultPosted throws when a review entry cannot be decoded', () => {
  const spawnSyncFn = (command, args) => {
    if (args[1] === 'user') return { status: 0, stdout: 'orchestrator\n', stderr: '' };
    return { status: 0, stdout: 'これは base64 ではない\n', stderr: '' };
  };
  assert.throws(() => defaultFindReviewResultPosted(
    { pr: 7, repo: 'owner/repo', workspace: '/tmp/ws', marker: 'm' },
    { spawnSyncFn, resolveRepoFn: () => ({ ok: true, repo: 'owner/repo' }) },
  ), /PRレビューの照合に失敗しました|不正なBase64/);
});

// gh の呼び出しを fake にする。args の並びで head 検索と本文検索を区別する。
function fakeGhPrList({ head, body }) {
  const calls = [];
  const spawnFn = (command, args) => {
    calls.push(args);
    const isHead = args.includes('--search');
    const answer = isHead ? head : body;
    return { status: answer.status ?? 0, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' };
  };
  return { spawnFn, calls };
}

test('defaultFindReviewPrs: head search non-zero exit throws and is not hidden by a successful body search', () => {
  const { spawnFn, calls } = fakeGhPrList({
    head: { status: 1, stderr: 'head failed' },
    body: { status: 0, stdout: '[]' },
  });
  assert.throws(() => defaultFindReviewPrs(5, 'owner/repo', '/tmp/ws', spawnFn), /head:issue-5 のPR検索に失敗しました: head failed/);
  assert.equal(calls.length, 1, 'body search must not mask a failed head search');
});

test('defaultFindReviewPrs: head search with invalid JSON throws even when the body search succeeds', () => {
  const { spawnFn } = fakeGhPrList({
    head: { status: 0, stdout: 'not json' },
    body: { status: 0, stdout: '[]' },
  });
  assert.throws(() => defaultFindReviewPrs(5, 'owner/repo', '/tmp/ws', spawnFn), /head:issue-5 のPR検索結果を解釈できません/);
});

test('defaultFindReviewPrs: head search with a non-array JSON throws', () => {
  const { spawnFn } = fakeGhPrList({
    head: { status: 0, stdout: '{"number":7}' },
    body: { status: 0, stdout: '[]' },
  });
  assert.throws(() => defaultFindReviewPrs(5, 'owner/repo', '/tmp/ws', spawnFn), /head:issue-5 のPR検索結果の形式が不正です/);
});

test('defaultFindReviewPrs: body search non-zero exit throws when the head search found nothing', () => {
  const { spawnFn } = fakeGhPrList({
    head: { status: 0, stdout: '[]' },
    body: { status: 2, stderr: 'body failed' },
  });
  assert.throws(() => defaultFindReviewPrs(5, 'owner/repo', '/tmp/ws', spawnFn), /本文参照のPR一覧を取得できません: body failed/);
});

test('defaultFindReviewPrs: body search with invalid JSON throws', () => {
  const { spawnFn } = fakeGhPrList({
    head: { status: 0, stdout: '[]' },
    body: { status: 0, stdout: '{broken' },
  });
  assert.throws(() => defaultFindReviewPrs(5, 'owner/repo', '/tmp/ws', spawnFn), /本文参照のPR一覧を解釈できません/);
});

test('defaultFindReviewPrs: body search with a non-array JSON throws', () => {
  const { spawnFn } = fakeGhPrList({
    head: { status: 0, stdout: '[]' },
    body: { status: 0, stdout: '{"number":7}' },
  });
  assert.throws(() => defaultFindReviewPrs(5, 'owner/repo', '/tmp/ws', spawnFn), /本文参照のPR一覧の形式が不正です/);
});

test('defaultFindReviewPrs: both searches succeed with no match returns an empty list', () => {
  const { spawnFn, calls } = fakeGhPrList({
    head: { status: 0, stdout: '[]' },
    body: { status: 0, stdout: '[{"number":9,"body":"#50 を参照"}]' },
  });
  assert.deepEqual(defaultFindReviewPrs(5, 'owner/repo', '/tmp/ws', spawnFn), []);
  assert.equal(calls.length, 2);
});

test('defaultFindReviewPrs: head match is returned as PR numbers', () => {
  const { spawnFn } = fakeGhPrList({
    head: { status: 0, stdout: '[{"number":7},{"number":8}]' },
    body: { status: 0, stdout: '[]' },
  });
  assert.deepEqual(defaultFindReviewPrs(5, 'owner/repo', '/tmp/ws', spawnFn), [7, 8]);
});

test('cleanup records a kept line with pr=? when defaultFindReviewPrs fails on a failed head search', () => {
  withWorkspaceWithArtifact(({ dir, artifactPath }) => {
    const { spawnFn } = fakeGhPrList({
      head: { status: 1, stderr: 'boom' },
      body: { status: 0, stdout: '[]' },
    });
    const result = cleanupIssueArtifacts(dir, 5, {
      findReviewPrsFn: (issue, repo, workspace) => defaultFindReviewPrs(issue, repo, workspace, spawnFn),
      findReviewResultPostedFn: () => { throw new Error('must not be called'); },
    });
    assert.equal(fs.existsSync(artifactPath), true);
    assert.deepEqual(formatReviewArtifactLines(result.reviewArtifacts).map((line) => line.slice(0, 'REVIEW_ARTIFACT_KEPT:pr=?'.length)), ['REVIEW_ARTIFACT_KEPT:pr=?']);
  });
});

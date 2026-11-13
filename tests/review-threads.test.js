'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('fs');
const path = require('path');
const { _setGraphqlExec } = require('../scripts/shared/graphql-client');
const { reviewFindingMarker } = require('../scripts/shared/review-finding-marker');
const { reviewArtifactPath } = require('../scripts/shared/review-manager-paths');
const { withTempDir } = require('../scripts/shared/temp-directory');
const threads = require('../scripts/review-threads');
const { queryStructuralErrors } = require('./_graphql-query-validate');

afterEach(() => _setGraphqlExec(undefined));

function graphqlResult(data) {
  return { status: 0, stdout: JSON.stringify({ data }), stderr: '' };
}

function threadNode({ id = 'PRRT_thread1', marker, isResolved = false, subjectType = 'LINE', commentId = 501 } = {}) {
  return {
    id,
    isResolved,
    subjectType,
    path: 'src/file.js',
    line: 8,
    comments: { nodes: [{
      databaseId: commentId,
      url: `https://github.com/acme/repo/pull/7#discussion_r${commentId}`,
      body: `[Correctness] 🔴 **BLOCKER**: finding summary\n\nbody\n\n${marker}`,
    }] },
  };
}

test('reviewThreads GraphQL query declares its variables and requests reply, URL, pagination, and resolution data', () => {
  for (const query of Object.values(threads.QUERIES)) {
    assert.deepEqual(queryStructuralErrors(query), []);
  }
  assert.match(threads.QUERIES.reviewThreads, /reviewThreads\(first:100,after:\$after\)/);
  assert.match(threads.QUERIES.reviewThreads, /isResolved subjectType path/);
  assert.match(threads.QUERIES.reviewThreads, /comments\(first:1\)\{nodes\{databaseId url body\}\}/);
  assert.match(threads.QUERIES.resolveReviewThread, /resolveReviewThread\(input:\{threadId:\$threadId\}\)/);
});

test('list fetches every reviewThreads page and returns exact marker, reply target, and thread identity', () => {
  const bytes = Buffer.from('{"pr":7,"findings":[{}]}');
  const marker = reviewFindingMarker(7, bytes, 1);
  const calls = [];
  const pages = [
    {
      repository: { pullRequest: { reviewThreads: {
        nodes: [threadNode({ marker })],
        pageInfo: { hasNextPage: true, endCursor: 'CURSOR-1' },
      } } },
    },
    {
      repository: { pullRequest: { reviewThreads: {
        nodes: [threadNode({ id: 'PRRT_other', marker: '<!-- unrelated -->', commentId: 502 })],
        pageInfo: { hasNextPage: false, endCursor: null },
      } } },
    },
  ];
  const result = threads.reviewManagerThreads(7, 'acme/repo', {
    graphqlExec(args) { calls.push(args); return graphqlResult(pages.shift()); },
  });

  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes(`query=${threads.QUERIES.reviewThreads}`));
  assert.ok(calls[0].includes('owner=acme'));
  assert.ok(calls[0].includes('name=repo'));
  assert.ok(calls[0].includes('number=7'));
  assert.ok(calls[1].includes('after=CURSOR-1'));
  assert.deepEqual(result, [{
    reviewManager: true,
    finding: 1,
    generation: marker.match(/sha256=([a-f0-9]+)/)[1],
    marker,
    threadId: 'PRRT_thread1',
    subjectType: 'LINE',
    commentId: 501,
    url: 'https://github.com/acme/repo/pull/7#discussion_r501',
    path: 'src/file.js',
    summary: 'finding summary',
    isResolved: false,
  }]);
});

test('workspace list matches manager.json raw bytes and finding order exactly', () => {
  withTempDir('gh-maestro-review-threads-', (workspace) => {
    fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
    const payload = {
      pr: 7,
      repo: 'acme/repo',
      headRefOid: '0123456789abcdef0123456789abcdef01234567',
      findings: [{
        aspect: 'Correctness',
        path: 'src/file.js',
        line_anchor: 'save()',
        summary: 'current summary',
        severity: 'BLOCKER',
        severity_rationale: 'data may be lost',
        body: 'await the save operation',
        verified_references: ['src/file.js'],
      }],
    };
    const bytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`);
    const artifact = reviewArtifactPath(workspace, 7, '.json');
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    fs.writeFileSync(artifact, bytes);
    const artifactHash = crypto.createHash('sha256').update(bytes).digest('hex');
    const marker = `<!-- gh-maestro:review-manager-finding:v1:pr=7:sha256=${artifactHash}:finding=1 -->`;
    const result = threads.currentReviewManagerThreads(7, 'acme/repo', workspace, {
      graphqlExec: () => graphqlResult({ repository: { pullRequest: { reviewThreads: {
        nodes: [threadNode({ marker, subjectType: 'FILE' })],
        pageInfo: { hasNextPage: false, endCursor: null },
      } } } }),
    });

    assert.equal(result.length, 1);
    assert.equal(result[0].marker, marker);
    assert.equal(result[0].subjectType, 'FILE');
    assert.equal(result[0].summary, 'current summary');
  });
});

test('status counts all unresolved PR threads and separately reports Review Manager thread state', () => {
  const marker1 = reviewFindingMarker(7, Buffer.from('one'), 1);
  const marker2 = reviewFindingMarker(7, Buffer.from('two'), 1);
  _setGraphqlExec(() => graphqlResult({
    repository: { pullRequest: { reviewThreads: {
      nodes: [
        threadNode({ id: 'PRRT_open', marker: marker1, commentId: 601 }),
        threadNode({ id: 'PRRT_closed', marker: marker2, isResolved: true, commentId: 602 }),
        threadNode({ id: 'PRRT_external', marker: '<!-- external -->', commentId: 603 }),
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    } } },
  }));

  assert.deepEqual(threads.reviewThreadStatus(7, 'acme/repo'), {
    pr: 7,
    totalReviewThreads: 3,
    unresolvedReviewThreads: 2,
    totalReviewManagerThreads: 2,
    unresolvedReviewManagerThreads: 1,
  });
});

test('list fails closed on GraphQL errors, malformed connections, repeated cursors, and duplicate finding markers', () => {
  assert.throws(() => threads.reviewManagerThreads(7, 'acme/repo', {
    graphqlExec: () => ({ status: 0, stdout: JSON.stringify({ errors: [{ message: 'denied' }] }) }),
  }), /denied/);

  assert.throws(() => threads.reviewManagerThreads(7, 'acme/repo', {
    graphqlExec: () => graphqlResult({ repository: { pullRequest: { reviewThreads: { nodes: [] } } } }),
  }), /完全な形で取得できません/);

  const marker = reviewFindingMarker(7, Buffer.from('same'), 1);
  assert.throws(() => threads.reviewManagerThreads(7, 'acme/repo', {
    graphqlExec: () => graphqlResult({ repository: { pullRequest: { reviewThreads: {
      nodes: [threadNode({ marker }), threadNode({ id: 'PRRT_duplicate', marker, commentId: 503 })],
      pageInfo: { hasNextPage: false, endCursor: null },
    } } } }),
  }), /複数あります/);

  let call = 0;
  assert.throws(() => threads.reviewManagerThreads(7, 'acme/repo', {
    graphqlExec: () => {
      call++;
      return graphqlResult({ repository: { pullRequest: { reviewThreads: {
        nodes: [], pageInfo: { hasNextPage: true, endCursor: 'same-cursor' },
      } } } });
    },
  }), /カーソルが不正です/);
  assert.equal(call, 2);
});

test('reply sends the PR-scoped GitHub REST reply endpoint, POST body over stdin, and rejects failed or malformed responses', () => {
  const calls = [];
  const result = threads.postReply(7, 'acme/repo', '501', '決定: 無視\n理由: 推奨どおり', (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: JSON.stringify({ id: 901, html_url: 'https://github.com/acme/repo/pull/7#discussion_r901' }), stderr: '' };
  });

  assert.deepEqual(result, { commentId: 901, url: 'https://github.com/acme/repo/pull/7#discussion_r901' });
  assert.equal(calls[0].command, 'gh');
  assert.deepEqual(calls[0].args, [
    'api', 'repos/acme/repo/pulls/7/comments/501/replies', '-X', 'POST', '-F', 'body=@-',
  ]);
  assert.equal(calls[0].options.input, '決定: 無視\n理由: 推奨どおり');
  assert.throws(() => threads.postReply(7, 'acme/repo', '501', 'body', () => ({ status: 1, stderr: 'denied' })), /返信に失敗/);
  assert.throws(() => threads.postReply(7, 'acme/repo', '501', 'body', () => ({ status: 0, stdout: '{}' })), /コメントIDまたはURL/);
});

test('resolve submits resolveReviewThread with the opaque GraphQL thread ID and verifies the returned state', () => {
  const threadId = 'PRRT_kwDOopaque';
  const calls = [];
  _setGraphqlExec((args) => {
    calls.push(args);
    return graphqlResult({ resolveReviewThread: { thread: { id: threadId, isResolved: true } } });
  });

  assert.deepEqual(threads.resolveReviewThread(threadId), { threadId, isResolved: true });
  assert.deepEqual(calls[0], [
    '-f', `query=${threads.QUERIES.resolveReviewThread}`,
    '-f', `threadId=${threadId}`,
  ]);

  _setGraphqlExec(() => graphqlResult({ resolveReviewThread: { thread: { id: threadId, isResolved: false } } }));
  assert.throws(() => threads.resolveReviewThread(threadId), /Resolve 済みとして返りません/);
});

test('CLI parser handles help and rejects missing command arguments', () => {
  assert.deepEqual(threads.parseArgs(['--help']), { mode: 'help' });
  assert.throws(() => threads.parseArgs([]), /位置引数が必要/);
  assert.equal(threads.main(['list', '--pr', '7'], {}).code, 1);
  assert.match(threads.main(['--help']).stdout, /review-threads\.js/);
});

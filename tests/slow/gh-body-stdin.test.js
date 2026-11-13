'use strict';

// 実プロセスの gh シム（fake-gh）を起動し、Windows 上で 32KB 超の日本語本文を
// stdin 経由で渡しても ENAMETOOLONG にならず欠損・文字化けなく届くことを検証する（Issue #774）。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createFakeGh } = require('../helpers/fake-gh');
const { withTempDir } = require('../../scripts/shared/temp-directory');
const { declareTestResult, buildCommentBody } = require('../../scripts/declare-test-result');
const { upsertDeclarationComment, DECLARATION_MARKER_PREFIX } = require('../../scripts/shared/pr-declaration');
const { publishPlan, PLAN_MARKER } = require('../../scripts/publish-plan');
const {
  postInlineComment,
  postFileComment,
  postFinalReview,
  formatFindingBody,
  formatFileFinding,
} = require('../../scripts/review-publisher');
const { finalizeReview } = require('../../scripts/finalize-review');
const { notifyManifestProblem } = require('../../scripts/run-review-jobs');

const SHA = '0123456789abcdef0123456789abcdef01234567';
const HASH = 'a'.repeat(64);

function withFakeGhEnv(fakeGh, { bypassTestContext = false } = {}, fn) {
  const savedPath = process.env.PATH;
  const savedNodeOptions = process.env.NODE_OPTIONS;
  const savedTestCtx = process.env.NODE_TEST_CONTEXT;
  process.env.PATH = fakeGh.env.PATH;
  process.env.NODE_OPTIONS = fakeGh.env.NODE_OPTIONS;
  if (bypassTestContext) delete process.env.NODE_TEST_CONTEXT;
  try {
    return fn();
  } finally {
    process.env.PATH = savedPath;
    if (savedNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = savedNodeOptions;
    if (savedTestCtx !== undefined) process.env.NODE_TEST_CONTEXT = savedTestCtx;
  }
}

async function withFakeGhEnvAsync(fakeGh, { bypassTestContext = false } = {}, fn) {
  const savedPath = process.env.PATH;
  const savedNodeOptions = process.env.NODE_OPTIONS;
  const savedTestCtx = process.env.NODE_TEST_CONTEXT;
  process.env.PATH = fakeGh.env.PATH;
  process.env.NODE_OPTIONS = fakeGh.env.NODE_OPTIONS;
  if (bypassTestContext) delete process.env.NODE_TEST_CONTEXT;
  try {
    return await fn();
  } finally {
    process.env.PATH = savedPath;
    if (savedNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = savedNodeOptions;
    if (savedTestCtx !== undefined) process.env.NODE_TEST_CONTEXT = savedTestCtx;
  }
}

function readRecordedBodies(stateFile) {
  return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
}

test('slow: declare-test-result.js は実プロセス境界で 32KB超の日本語本文を新規投稿・更新できる', () => {
  withTempDir('ghm-slow-dtr-', (dir) => {
    const stateFile = path.join(dir, 'posted.json');
    const layers = {};
    for (let i = 0; i < 600; i++) {
      layers[`layer-${i}-日本語テスト層`] = {
        status: 'complete', outcome: 'pass', tests: 10, pass: 10, fail: 0,
        executor: 'test-runner', scope: 'full', testedContentHash: HASH,
        executionLogPath: `log-日本語-${i}.json`,
      };
    }
    const artifact = { provenance: 'test-runner', scope: 'aggregate', layers };
    const expectedBody = buildCommentBody({ commit: SHA, testResult: artifact });
    assert.ok(Buffer.byteLength(expectedBody, 'utf8') > 65536, 'テスト前提: 64KB超の日本語本文');

    const fakeGh = createFakeGh({
      binDir: path.join(dir, 'bin'),
      fixtures: [
        {
          match: { prefix: ['api', 'repos/owner/repo/issues/42/comments', '-X', 'POST'] },
          action: 'append-body-file',
          bodyFlag: '-F',
          stateFile,
          fields: { op: 'create' },
          stdout: JSON.stringify({ html_url: 'https://github.com/owner/repo/pull/42#issuecomment-10' }),
        },
        {
          match: { prefix: ['api', '-X', 'PATCH', 'repos/owner/repo/issues/comments/10'] },
          action: 'append-body-file',
          bodyFlag: '-F',
          stateFile,
          fields: { op: 'update' },
          stdout: JSON.stringify({ html_url: 'https://github.com/owner/repo/pull/42#issuecomment-10' }),
        },
      ],
    });

    withFakeGhEnv(fakeGh, {}, () => {
      const created = declareTestResult(
        { pr: '42', repo: 'owner/repo', headSha: SHA },
        {
          gitHeadFn: () => SHA,
          readTestResultFn: () => ({ ok: true, result: artifact }),
          commitContentHashFn: () => HASH,
          ghListCommentsFn: () => ({ status: 0, stdout: '[]', stderr: '' }),
        },
      );
      assert.equal(created.ok, true, created.error);

      const updated = declareTestResult(
        { pr: '42', repo: 'owner/repo', headSha: SHA },
        {
          gitHeadFn: () => SHA,
          readTestResultFn: () => ({ ok: true, result: artifact }),
          commitContentHashFn: () => HASH,
          ghListCommentsFn: () => ({
            status: 0,
            stdout: JSON.stringify([{ id: 10, body: expectedBody, html_url: 'https://github.com/owner/repo/pull/42#issuecomment-10' }]),
            stderr: '',
          }),
        },
      );
      assert.equal(updated.ok, true, updated.error);
    });

    const recorded = readRecordedBodies(stateFile);
    assert.deepEqual(recorded.map(r => r.op), ['create', 'update']);
    assert.equal(recorded[0].body, expectedBody);
    assert.equal(recorded[1].body, expectedBody);
  });
});

test('slow: pr-declaration.js は実プロセス境界で約98KBの日本語申告表を新規投稿・更新できる', () => {
  withTempDir('ghm-slow-prdecl-', (dir) => {
    const stateFile = path.join(dir, 'posted.json');
    const rows = Array.from({ length: 500 }, (_, i) =>
      `| tests/sample-${i}.test.js:10 テスト${i} | ロジック${i}の欠陥で日本語アサーションが失敗する | 要件定義#${i} | 未実施（範囲外）: 欠陥${i}を直接比較で検出 |`
    );
    const largeTable = ['| テスト | 何が壊れたら失敗するか | 期待値の出所 | 変異確認 |', '|---|---|---|---|', ...rows].join('\n');
    const expectedBody = `<!-- ${DECLARATION_MARKER_PREFIX} head=${SHA} -->\n${largeTable}\n`;
    assert.ok(Buffer.byteLength(expectedBody, 'utf8') > 98000, 'テスト前提: 98KB超の日本語申告表');

    const fakeGh = createFakeGh({
      binDir: path.join(dir, 'bin'),
      fixtures: [
        {
          match: { prefix: ['api', 'repos/owner/repo/issues/5/comments', '-X', 'POST'] },
          action: 'append-body-file',
          bodyFlag: '-F',
          stateFile,
          fields: { op: 'create' },
          stdout: JSON.stringify({ html_url: 'https://github.com/owner/repo/pull/5#issuecomment-77' }),
        },
        {
          match: { prefix: ['api', '-X', 'PATCH', 'repos/owner/repo/issues/comments/77'] },
          action: 'append-body-file',
          bodyFlag: '-F',
          stateFile,
          fields: { op: 'update' },
          stdout: JSON.stringify({ html_url: 'https://github.com/owner/repo/pull/5#issuecomment-77' }),
        },
      ],
    });

    withFakeGhEnv(fakeGh, {}, () => {
      const created = upsertDeclarationComment({
        pr: 5,
        repo: 'owner/repo',
        headSha: SHA,
        table: largeTable,
        listCommentsFn: () => ({ status: 0, stdout: '[]' }),
      });
      assert.equal(created.ok, true, created.error);

      const updated = upsertDeclarationComment({
        pr: 5,
        repo: 'owner/repo',
        headSha: SHA,
        table: largeTable,
        listCommentsFn: () => ({
          status: 0,
          stdout: JSON.stringify([{
            id: 77,
            body: `<!-- ${DECLARATION_MARKER_PREFIX} head=${SHA} -->\n旧表`,
            author_association: 'OWNER',
            html_url: 'https://github.com/owner/repo/pull/5#issuecomment-77',
          }]),
        }),
      });
      assert.equal(updated.ok, true, updated.error);
    });

    const recorded = readRecordedBodies(stateFile);
    assert.deepEqual(recorded.map(r => r.op), ['create', 'update']);
    assert.equal(recorded[0].body, expectedBody);
    assert.equal(recorded[1].body, expectedBody);
  });
});

test('slow: publish-plan.js は実プロセス境界で 32KB超の日本語計画を新規投稿・更新できる', () => {
  withTempDir('ghm-slow-plan-', (dir) => {
    const stateFile = path.join(dir, 'posted.json');
    const largePlan = '# 計画\n' + '日本語の実装計画詳細と検証手順。\n'.repeat(1200);
    const expectedBody = `${PLAN_MARKER}\n${largePlan}`;
    assert.ok(Buffer.byteLength(expectedBody, 'utf8') > 32768);

    const fakeGh = createFakeGh({
      binDir: path.join(dir, 'bin'),
      fixtures: [
        { match: { prefix: ['repo', 'view'] }, stdout: 'owner/repo\n' },
        {
          match: { prefix: ['api', 'repos/owner/repo/issues/42/comments', '-X', 'POST'] },
          action: 'append-body-file',
          bodyFlag: '-F',
          stateFile,
          fields: { op: 'create' },
          stdout: JSON.stringify({ id: 500, html_url: 'https://github.com/owner/repo/issues/42#issuecomment-500' }),
        },
        {
          match: { prefix: ['api', '-X', 'PUT', 'repos/owner/repo/issues/comments/500/pin'] },
          stdout: '',
        },
        {
          match: { prefix: ['api', '-X', 'PATCH', 'repos/owner/repo/issues/comments/500'] },
          action: 'append-body-file',
          bodyFlag: '-F',
          stateFile,
          fields: { op: 'update' },
          stdout: JSON.stringify({ id: 500, html_url: 'https://github.com/owner/repo/issues/42#issuecomment-500' }),
        },
      ],
    });

    withFakeGhEnv(fakeGh, {}, () => {
      const created = publishPlan(
        { issue: '42', body: largePlan, workspace: dir },
        { ghListCommentsFn: () => ({ status: 0, stdout: '[]', stderr: '' }) },
      );
      assert.equal(created.ok, true, created.error);

      const updated = publishPlan(
        { issue: '42', body: largePlan, workspace: dir },
        {
          ghListCommentsFn: () => ({
            status: 0,
            stdout: JSON.stringify([{ id: 500, body: `${PLAN_MARKER}\n旧`, pin: { pinned_at: '2026-01-01T00:00:00Z' } }]),
            stderr: '',
          }),
        },
      );
      assert.equal(updated.ok, true, updated.error);
    });

    const recorded = readRecordedBodies(stateFile);
    assert.deepEqual(recorded.map(r => r.op), ['create', 'update']);
    assert.equal(recorded[0].body, expectedBody);
    assert.equal(recorded[1].body, expectedBody);
  });
});

test('slow: review-publisher.js は実プロセス境界で 32KB超の日本語レビューを投稿できる', () => {
  withTempDir('ghm-slow-revpub-', (dir) => {
    const stateFile = path.join(dir, 'posted.json');
    const largeBody = '日本語のレビュー指摘詳細テキスト。\n'.repeat(1500);
    assert.ok(Buffer.byteLength(largeBody, 'utf8') > 32768);

    const payload = { repo: 'acme/repo', pr: 12, headRefOid: 'deadbeef' };
    const marker = '<!-- gh-maestro:review-manager-finding:v1:pr=12:sha256=abc:finding=1 -->';
    const inlineFinding = {
      aspect: 'Correctness',
      path: 'src/foo.js',
      line_anchor: 'save()',
      summary: '日本語サマリー',
      severity: 'MAJOR',
      severity_rationale: '理由',
      body: largeBody,
      verified_references: ['src/foo.js'],
      resolved_line: 8,
      review_finding_marker: marker,
    };
    const fileItem = { finding: inlineFinding, status: 'unresolved_anchor' };

    const fakeGh = createFakeGh({
      binDir: path.join(dir, 'bin'),
      fixtures: [
        {
          match: { prefix: ['api', 'repos/acme/repo/pulls/12/comments', '-X', 'POST'] },
          action: 'append-body-file',
          bodyFlag: '-F',
          stateFile,
          fields: { op: 'comment' },
          stdout: '{}',
        },
        {
          match: { prefix: ['api', 'repos/acme/repo/pulls/12/reviews', '-X', 'POST'] },
          action: 'append-body-file',
          bodyFlag: '-F',
          stateFile,
          fields: { op: 'review' },
          stdout: '{}',
        },
      ],
    });

    withFakeGhEnv(fakeGh, {}, () => {
      postInlineComment(payload, inlineFinding);
      postFileComment(payload, fileItem);
      postFinalReview(payload, largeBody);
    });

    const recorded = readRecordedBodies(stateFile);
    assert.equal(recorded.length, 3);
    assert.equal(recorded[0].body, formatFindingBody(inlineFinding, marker));
    assert.equal(recorded[1].body, formatFileFinding(fileItem, marker));
    assert.equal(recorded[2].body, largeBody);
  });
});

test('slow: finalize-review.js は実プロセス境界で 32KB超の日本語不完全レビューコメントを投稿できる', async () => {
  await withTempDir('ghm-slow-fr-', async (dir) => {
    const stateFile = path.join(dir, 'posted.json');
    const findings = Array.from({ length: 120 }, (_, i) => ({
      aspect: 'Correctness',
      path: `src/file-${i}.js`,
      line_anchor: `anchor_${i}()`,
      summary: `日本語の指摘要約-${i}`,
      severity: 'MAJOR',
      severity_rationale: `理由-${i}`,
      body: `詳細本文-${i}: 日本語の根拠説明。`.repeat(12),
      verified_references: [`src/file-${i}.js`],
    }));
    const results = {
      manifest_ref: { pr: 5, repo: 'o/r', headRefOid: 'abc' },
      coverage_ledger: {
        leaves: [
          { id: 'correctness/logic-invariants', trunk: 'Correctness', decision: 'adopted', rationale: null },
          { id: 'correctness/api-contract', trunk: 'Correctness', decision: 'adopted', rationale: null },
        ],
      },
      jobs: [
        { id: 'job-1', status: 'success', leaf_ids: ['correctness/logic-invariants'], findings },
        { id: 'job-2', status: 'failed', leaf_ids: ['correctness/api-contract'], error: 'timeout', findings: [] },
      ],
    };
    const resultsPath = path.join(dir, 'results.json');
    fs.writeFileSync(resultsPath, JSON.stringify(results), 'utf8');

    const fakeGh = createFakeGh({
      binDir: path.join(dir, 'bin'),
      fixtures: [
        {
          match: { prefix: ['pr', 'comment', '5', '--repo', 'o/r', '--body-file', '-'] },
          action: 'append-body-file',
          bodyFlag: '--body-file',
          stateFile,
          stdout: 'https://github.com/o/r/pull/5#issuecomment-900\n',
        },
      ],
    });

    const res = await withFakeGhEnvAsync(fakeGh, { bypassTestContext: true }, () =>
      finalizeReview(resultsPath, 'incomplete', null, dir)
    );
    assert.equal(res.ok, true, JSON.stringify(res.summary));
    const recorded = readRecordedBodies(stateFile);
    assert.equal(recorded.length, 1);
    const posted = recorded[0].body;
    assert.ok(Buffer.byteLength(posted, 'utf8') > 32768, `32KB超のはず: ${Buffer.byteLength(posted, 'utf8')}`);
    const expectedFindingsSection = [
      '## ⚠️ 不完全レビュー',
      '',
      'このレビューは**不完全**です。以下の理由により、正式なReview Managerレビュー完了とはみなされません。',
      '',
      '---',
      '',
      '### 成功した葉',
      '',
      '- **correctness/logic-invariants**: 120件の所見',
      '',
      '### 最後の実行で成功したジョブの指摘',
      '',
      '最終スナップショットの成功ジョブから集約（120 件）。',
      '',
      ...findings.flatMap((f) => [
        '<details>',
        `<summary><b>[${f.severity}] [${f.aspect}] ${f.path}</b> — ${f.summary}</summary>`,
        '',
        `行アンカー: \`${f.line_anchor}\``,
        `判定根拠: ${f.severity_rationale}`,
        `参照: ${f.verified_references.join(', ')}`,
        '',
        f.body,
        '',
        '</details>',
        '',
      ]),
      '',
      '### 失敗/未完了の葉',
      '',
      '- **correctness/api-contract**: timeout',
      '',
      '### 除外した葉',
      '',
      '（なし）',
    ].join('\n');
    const [actualBeforeReasons, actualReasonsAndFooter] = posted.split('\n\n### 完全性ゲート不合格理由\n\n');
    assert.equal(actualBeforeReasons, expectedFindingsSection);
    assert.match(actualReasonsAndFooter, /adopted leaf correctness\/api-contract has only failed job results/);
    assert.match(actualReasonsAndFooter, /_最終更新: \d{4}-\d{2}-\d{2}T/);
  });
});

test('slow: run-review-jobs.js は実プロセス境界で 32KB超の日本語不完全通知コメントを投稿できる', () => {
  withTempDir('ghm-slow-rrj-', (dir) => {
    const stateFile = path.join(dir, 'posted.json');
    const largeBody = '不完全レビュー通知（日本語）\n' + 'マニフェスト詳細エラー行。\n'.repeat(1200);
    assert.ok(Buffer.byteLength(largeBody, 'utf8') > 32768);

    const fakeGh = createFakeGh({
      binDir: path.join(dir, 'bin'),
      fixtures: [
        {
          match: { prefix: ['pr', 'comment', '42', '--repo', 'o/r', '--body-file', '-'] },
          action: 'append-body-file',
          bodyFlag: '--body-file',
          stateFile,
          stdout: 'https://github.com/o/r/pull/42#issuecomment-901\n',
        },
      ],
    });

    const res = withFakeGhEnv(fakeGh, { bypassTestContext: true }, () =>
      notifyManifestProblem({
        workspace: dir,
        pr: 42,
        repo: 'o/r',
        commentBody: largeBody,
        failureLabel: '検証失敗',
        failureDetail: '詳細',
      })
    );
    assert.equal(res.posted, true, res.error);
    const recorded = readRecordedBodies(stateFile);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].body, largeBody);
  });
});

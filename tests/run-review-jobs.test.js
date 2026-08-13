'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  validateManifest,
  validateJobs,
  buildJobPrompt,
  launchJobWorker,
  runJobsFromManifest,
  buildManifestValidationComment,
  notifyManifestValidationFailure,
  _setGhForTest,
} = require('../scripts/run-review-jobs');

const { ALL_LEAF_IDS, TRUNK_TO_LEAVES } = require('../scripts/shared/review-aspects');
const { reviewArtifactPath } = require('../scripts/shared/review-manager-paths');

test('validateManifest: valid manifest passes', () => {
  const manifest = {
    pr: 123,
    repo: 'owner/repo',
    headRefOid: 'abc123',
    changedFiles: ['src/a.ts'],
    coverage_ledger: {
      leaves: ALL_LEAF_IDS.map(id => ({
        id,
        trunk: Object.entries(TRUNK_TO_LEAVES).find(([, leaves]) => leaves.includes(id))[0],
        decision: 'adopted',
        rationale: null,
      })),
    },
    jobs: [
      {
        id: 'job-1',
        leaf_ids: [...ALL_LEAF_IDS],
        aspect: 'Correctness',
        trunk_dir: 'skills/gh-maestro-reviewer/correctness',
        leaf_files: ALL_LEAF_IDS.map(id => 'skills/gh-maestro-reviewer/' + id + '.md'),
      },
    ],
    parallelism: 'parallel',
  };
  const { valid, errors } = validateManifest(manifest);
  assert.equal(valid, true, 'unexpected errors: ' + errors.join('; '));
  assert.deepEqual(errors, []);
});

test('validateManifest: missing leaf from coverage_ledger fails', () => {
  const manifest = {
    pr: 1, repo: 'o/r', headRefOid: 'abc',
    coverage_ledger: {
      leaves: [
        { id: 'correctness/logic-invariants', trunk: 'Correctness', decision: 'adopted', rationale: null },
      ],
    },
    jobs: [],
  };
  const { valid, errors } = validateManifest(manifest);
  assert.equal(valid, false);
  assert.ok(errors.some(e => e.includes('missing from coverage_ledger')));
});

test('validateManifest: excluded leaf without rationale fails', () => {
  const leaves = ALL_LEAF_IDS.map(id => ({
    id,
    trunk: Object.entries(TRUNK_TO_LEAVES).find(([, lvs]) => lvs.includes(id))[0],
    decision: id === 'correctness/logic-invariants' ? 'excluded' : 'adopted',
    rationale: id === 'correctness/logic-invariants' ? '' : null,
  }));
  const adoptedIds = leaves.filter(l => l.decision === 'adopted').map(l => l.id);
  const manifest = {
    pr: 1, repo: 'o/r', headRefOid: 'abc',
    coverage_ledger: { leaves },
    jobs: [{ id: 'job-1', leaf_ids: adoptedIds, aspect: 'Correctness', trunk_dir: 'd', leaf_files: ['f.md'] }],
    parallelism: 'parallel',
  };
  const { valid, errors } = validateManifest(manifest);
  assert.equal(valid, false);
  assert.ok(errors.some(e => e.includes('rationale')));
});

test('validateManifest: adopted leaf not assigned to any job fails', () => {
  const leaves = ALL_LEAF_IDS.map(id => ({
    id,
    trunk: Object.entries(TRUNK_TO_LEAVES).find(([, lvs]) => lvs.includes(id))[0],
    decision: 'adopted',
    rationale: null,
  }));
  const manifest = {
    pr: 1, repo: 'o/r', headRefOid: 'abc',
    coverage_ledger: { leaves },
    jobs: [{ id: 'job-1', leaf_ids: ['correctness/logic-invariants'], aspect: 'Correctness', trunk_dir: 'd', leaf_files: ['f.md'] }],
    parallelism: 'parallel',
  };
  const { valid, errors } = validateManifest(manifest);
  assert.equal(valid, false);
  assert.ok(errors.some(e => e.includes('not assigned to any job')));
});

test('validateManifest: empty jobs when adopted leaves exist fails', () => {
  const leaves = ALL_LEAF_IDS.map(id => ({
    id,
    trunk: Object.entries(TRUNK_TO_LEAVES).find(([, lvs]) => lvs.includes(id))[0],
    decision: 'adopted',
    rationale: null,
  }));
  const manifest = {
    pr: 1, repo: 'o/r', headRefOid: 'abc',
    coverage_ledger: { leaves },
    jobs: [],
    parallelism: 'parallel',
  };
  const { valid, errors } = validateManifest(manifest);
  assert.equal(valid, false);
  assert.ok(errors.some(e => e.includes('must not be empty')));
});

test('buildJobPrompt includes aspect and prohibition text', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gjpm-'));
  try {
    const leafPath = path.join(tmpDir, 'skills/gh-maestro-reviewer/correctness/test-leaf.md');
    fs.mkdirSync(path.dirname(leafPath), { recursive: true });
    fs.writeFileSync(leafPath, '# Test Leaf\n\nTest content.', 'utf8');
    const job = { id: 'job-1', leaf_ids: ['correctness/test-leaf'], aspect: 'Correctness', trunk_dir: 'skills/gh-maestro-reviewer/correctness', leaf_files: ['skills/gh-maestro-reviewer/correctness/test-leaf.md'] };
    const manifest = { pr: 123, repo: 'o/r', headRefOid: 'abc123', changedFiles: ['src/a.ts'] };
    const prompt = buildJobPrompt(job, manifest, tmpDir);
    assert.match(prompt, /Correctness/);
    assert.match(prompt, /Test content/);
    assert.match(prompt, /PR #123/);
    assert.match(prompt, /npm test/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('validateManifest: acceptanceCriteria is optional and validates non-empty string arrays', () => {
  const leaves = ALL_LEAF_IDS.map(id => ({
    id,
    trunk: Object.entries(TRUNK_TO_LEAVES).find(([, lvs]) => lvs.includes(id))[0],
    decision: 'adopted', rationale: null,
  }));
  const base = {
    pr: 1, repo: 'o/r', headRefOid: 'abc', coverage_ledger: { leaves },
    jobs: [{ id: 'job-1', leaf_ids: [...ALL_LEAF_IDS], aspect: 'Correctness', trunk_dir: 'd', leaf_files: ['f.md'] }],
  };
  assert.equal(validateManifest(base).valid, true);
  assert.equal(validateManifest({ ...base, acceptanceCriteria: ['条件A', '条件B'] }).valid, true);
  for (const value of ['', [''], ['  '], '条件A', [], [1]]) {
    const result = validateManifest({ ...base, acceptanceCriteria: value });
    assert.equal(result.valid, false, `expected invalid acceptanceCriteria: ${JSON.stringify(value)}`);
  }
});

test('buildJobPrompt passes manifest acceptance criteria without external lookup', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gjpm-acceptance-'));
  try {
    const leafPath = path.join(tmpDir, 'leaf.md');
    fs.writeFileSync(leafPath, '# Leaf', 'utf8');
    const prompt = buildJobPrompt(
      { id: 'job-1', leaf_ids: ['correctness/logic-invariants'], aspect: 'Correctness', leaf_files: ['leaf.md'] },
      {
        pr: 123, repo: 'o/r', headRefOid: 'abc123', changedFiles: ['src/a.ts'],
        acceptanceCriteria: ['保存後に内容を保持する', '失敗時に状態を維持する'],
      },
      tmpDir,
    );
    assert.match(prompt, /保存後に内容を保持する/);
    assert.match(prompt, /失敗時に状態を維持する/);
    assert.match(prompt, /manifestに存在する受け入れ条件/);
    assert.match(prompt, /評価対象は従来どおり変更差分の中に限ってください/);
    assert.doesNotMatch(prompt, /gh issue view/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('buildJobPrompt keeps the legacy input when manifest has no acceptance criteria', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gjpm-no-acceptance-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'leaf.md'), '# Leaf', 'utf8');
    const prompt = buildJobPrompt(
      { id: 'job-1', leaf_ids: ['correctness/logic-invariants'], aspect: 'Correctness', leaf_files: ['leaf.md'] },
      { pr: 123, repo: 'o/r', headRefOid: 'abc123', changedFiles: ['src/a.ts'] },
      tmpDir,
    );
    assert.match(prompt, /以下のdiffと変更ファイル一覧、およびmanifestに存在する受け入れ条件だけ/);
    assert.doesNotMatch(prompt, /保存後に内容を保持する/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('launchJobWorker: execArgsが非対話化トークンを欠くとspawnせずfailedになる（Issue #163 BLOCKER）', async () => {
  // 修正前の検証漏れを再現: extraArgs はトークンを保持しているが、ジョブワーカーが
  // 実際に使う execArgs ?? extraArgs のうち execArgs が対話モード化されているケース。
  // ガードは spawn より前で解決するため、実プロセスは起動しない。
  const result = await launchJobWorker(
    { id: 'job-1', leaf_ids: ['leaf-1'], aspect: 'Correctness' },
    { pr: 1 },
    {
      id: 'codex',
      nonInteractiveTokens: ['exec'],
      extraArgs: ['exec', '--skip-git-repo-check'],
      execArgs: ['--skip-git-repo-check'], // exec を欠落
    },
    '/tmp/review-wt',
    '/tmp/ws',
    10000,
    null,
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.jobId, 'job-1');
  assert.ok(result.error.includes('exec'), `error が欠落トークン exec に言及: ${result.error}`);
  assert.ok(result.error.includes('non-interactive token'), `error が非対話化トークンに言及: ${result.error}`);
});

// ── Issue #271: manifest検証失敗の通知 ─────────────────────────────────────────
// 実行manifestの機械検証に失敗した場合、検証エラーをPRへのプレーンコメントと
// .incomplete センチネルで通知し、そのまま終了する（ヘッドレス再試行はしない）。
// 冪等性・NODE_TEST_CONTEXTガード・gh注入（実プロセス0個）を検証する。

test('buildManifestValidationComment: 検証エラーをプレーンコメント本文に含める', () => {
  const body = buildManifestValidationComment(
    { pr: 42, repo: 'owner/repo' },
    [
      'leaf correctness/logic-invariants is missing from coverage_ledger',
      'jobs: each entry must be an object',
    ],
  );
  assert.match(body, /PR #42/);
  assert.match(body, /機械検証に合格しなかった/);
  assert.match(body, /correctness\/logic-invariants is missing/);
  assert.match(body, /jobs: each entry must be an object/);
  // 再試行しないこと・書き直し判断がオーケストレーターにあることを明示する
  assert.match(body, /書き直し・再実行は行いません/);
});

test('notifyManifestValidationFailure: gh投稿（注入）とセンチネル作成を実行する', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvmf-'));
  try {
    const ghCalls = [];
    _setGhForTest((args) => {
      ghCalls.push(args);
      return { status: 0, stdout: 'https://github.com/owner/repo/pull/42#issuecomment-1\n' };
    });

    // 実投稿がテスト中に漏れないバックストップ（Issue #202の二層対策）。
    // _setGhForTest 注入が優先されるため、実ghは呼ばれない。
    process.env.NODE_TEST_CONTEXT = '1';
    try {
      const result = notifyManifestValidationFailure({
        manifest: { pr: 42, repo: 'owner/repo', headRefOid: 'abc' },
        workspace: testDir,
        errors: ['leaf x is missing from coverage_ledger'],
      });
      assert.equal(result.skipped, false);
      assert.equal(result.posted, true);
      assert.equal(result.commentUrl, 'https://github.com/owner/repo/pull/42#issuecomment-1');
      assert.equal(result.error, null);
      assert.ok(result.sentinelPath);
      assert.ok(fs.existsSync(result.sentinelPath), `sentinel should be created: ${result.sentinelPath}`);
    } finally {
      delete process.env.NODE_TEST_CONTEXT;
    }

    // gh pr comment が正しい引数で呼ばれた
    assert.equal(ghCalls.length, 1);
    const args = ghCalls[0];
    assert.equal(args[0], 'pr');
    assert.equal(args[1], 'comment');
    assert.equal(args[2], '42');
    assert.equal(args[3], '--repo');
    assert.equal(args[4], 'owner/repo');
    assert.ok(args.includes('--body'), 'gh args should include --body');
  } finally {
    _setGhForTest(null);
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test('notifyManifestValidationFailure: センチネル既存時は再投稿しない（冪等）', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvmf-idem-'));
  try {
    // 事前にセンチネルを作成（同一PRでの再実行を模す）
    const sentinelPath = reviewArtifactPath(path.join(testDir, '.gh-maestro'), 7, '.incomplete');
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
    fs.writeFileSync(sentinelPath, '{}', 'utf8');

    const ghCalls = [];
    _setGhForTest((args) => { ghCalls.push(args); return { status: 0, stdout: '' }; });
    process.env.NODE_TEST_CONTEXT = '1';
    try {
      const result = notifyManifestValidationFailure({
        manifest: { pr: 7, repo: 'o/r' },
        workspace: testDir,
        errors: ['bad'],
      });
      assert.equal(result.skipped, true);
      assert.equal(result.posted, false);
      assert.equal(ghCalls.length, 0, 'センチネル既存時は gh を呼ばない');
    } finally {
      delete process.env.NODE_TEST_CONTEXT;
    }
  } finally {
    _setGhForTest(null);
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test('notifyManifestValidationFailure: NODE_TEST_CONTEXT時は実投稿せずセンチネルだけ書く', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvmf-guard-'));
  try {
    _setGhForTest(null); // 注入なし: 本番経路（実gh）をガードがブロックすることを検証
    process.env.NODE_TEST_CONTEXT = '1';
    try {
      const result = notifyManifestValidationFailure({
        manifest: { pr: 3, repo: 'o/r' },
        workspace: testDir,
        errors: ['bad'],
      });
      assert.equal(result.posted, false);
      assert.ok(result.error && result.error.includes('NODE_TEST_CONTEXT'), `error should mention guard: ${result.error}`);
      assert.ok(fs.existsSync(result.sentinelPath), 'センチネルはガード時も作成される');
    } finally {
      delete process.env.NODE_TEST_CONTEXT;
    }
  } finally {
    _setGhForTest(null);
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test('runJobsFromManifest: 検証失敗時に通知を実行し ok:false で返す', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rjf-invalid-'));
  try {
    const manifestPath = path.join(testDir, 'manifest.json');
    const resultsPath = path.join(testDir, 'results.json');
    // 機械検証に落ちるmanifest（7葉から1葉しか含まない + jobs空）
    const invalidManifest = {
      pr: 11, repo: 'o/r', headRefOid: 'abc',
      coverage_ledger: {
        leaves: [{ id: 'correctness/logic-invariants', trunk: 'Correctness', decision: 'adopted', rationale: null }],
      },
      jobs: [],
    };
    fs.writeFileSync(manifestPath, JSON.stringify(invalidManifest), 'utf8');

    const ghCalls = [];
    _setGhForTest((args) => { ghCalls.push(args); return { status: 0, stdout: 'url\n' }; });
    process.env.NODE_TEST_CONTEXT = '1';
    try {
      const result = await runJobsFromManifest(manifestPath, resultsPath, testDir, 10000, 10000);
      assert.equal(result.ok, false);
      assert.equal(result.summary.error, 'manifest validation failed');
      assert.ok(Array.isArray(result.summary.details) && result.summary.details.length > 0);
      assert.ok(result.summary.notification, 'summaryに通知結果を含める');
      assert.equal(result.summary.notification.posted, true);
      assert.equal(ghCalls.length, 1, '検証失敗時に gh pr comment を1回呼ぶ');
    } finally {
      delete process.env.NODE_TEST_CONTEXT;
    }
  } finally {
    _setGhForTest(null);
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

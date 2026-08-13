'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const { cleanSpawnEnv } = require('./_spawn-env');

const {
  validateManifest,
  validateJobs,
  buildJobPrompt,
  launchJobWorker,
  runJobsFromManifest,
  buildManifestValidationComment,
  buildManifestLoadFailureComment,
  notifyManifestValidationFailure,
  notifyManifestProblem,
  resolveNotifyPr,
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

test('notifyManifestValidationFailure: 通知済みセンチネル既存時は再投稿しない（冪等）', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvmf-idem-'));
  try {
    // 事前に「通知済み」センチネルを作成（同一PRでの再実行を模す）。
    // reason 'incomplete-review' のときだけスキップ対象（notify-failed は再投稿する）。
    const sentinelPath = reviewArtifactPath(path.join(testDir, '.gh-maestro'), 7, '.incomplete');
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
    fs.writeFileSync(sentinelPath, JSON.stringify({ pr: 7, reason: 'incomplete-review', completed_at: 'x' }), 'utf8');

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

test('notifyManifestValidationFailure: NODE_TEST_CONTEXT時は実投稿せずnotify-failedセンチネルを書く', () => {
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
      // 投稿が「失敗」した扱いなので、通知成功センチネルではなく notify-failed センチネルを書く
      assert.ok(fs.existsSync(result.sentinelPath), 'センチネルはガード時も作成される');
      const sentinelContent = JSON.parse(fs.readFileSync(result.sentinelPath, 'utf8'));
      assert.equal(sentinelContent.reason, 'notify-failed');
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

// ── PR #272 レビュー指摘の回帰テスト ─────────────────────────────────────────
// 欠陥A: 投稿失敗時も成功センチネルを書いていた → 通知成功を偽装 + 冪等ガードが再投稿を塞ぐ
// 欠陥B: manifest.pr が不正（0・欠落）だと reviewArtifactPath が throw し、コメントも
//   センチネルも書かれず黙って終わっていた

test('resolveNotifyPr: 候補の先頭から正整数を選ぶ', () => {
  assert.equal(resolveNotifyPr([42]), '42');
  assert.equal(resolveNotifyPr([undefined, '12']), '12');
  assert.equal(resolveNotifyPr(['12', 7]), '12');
  assert.equal(resolveNotifyPr(['07']), null);       // 先頭ゼロは正整数として受理しない
  assert.equal(resolveNotifyPr([0, 'abc', -1]), null);
  assert.equal(resolveNotifyPr([undefined, undefined]), null);
});

test('notifyManifestValidationFailure: 投稿失敗時は成功センチネルを作らずnotify-failedを書く（欠陥A）', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvmf-postfail-'));
  try {
    // 投稿が非ゼロで失敗（認証切れ・ネットワーク障害を模す）
    _setGhForTest(() => ({ status: 1, stdout: '', stderr: 'auth failed: token expired' }));
    process.env.NODE_TEST_CONTEXT = '1';
    try {
      const result = notifyManifestValidationFailure({
        manifest: { pr: 42, repo: 'owner/repo', headRefOid: 'abc' },
        workspace: testDir,
        errors: ['leaf x is missing from coverage_ledger'],
      });
      assert.equal(result.posted, false);
      assert.ok(result.error && result.error.includes('auth failed'), `error should carry gh stderr: ${result.error}`);
      assert.ok(result.sentinelPath && fs.existsSync(result.sentinelPath), 'notify-failedセンチネルは作られる');
      const sentinel = JSON.parse(fs.readFileSync(result.sentinelPath, 'utf8'));
      assert.equal(sentinel.reason, 'notify-failed', '投稿失敗時に通知成功を示す reason にしない');
      assert.notEqual(sentinel.reason, 'incomplete-review');
      assert.equal(sentinel.postError, 'auth failed: token expired');
      // 失敗内容は failureLabel / failureDetail で記録され、監督側がログで確認できる
      assert.equal(sentinel.failureLabel, '検証エラー');
      assert.equal(sentinel.failureDetail, 'leaf x is missing from coverage_ledger');
    } finally {
      delete process.env.NODE_TEST_CONTEXT;
    }
  } finally {
    _setGhForTest(null);
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test('notifyManifestValidationFailure: notify-failedセンチネル残存時は再投稿して回復する（冪等は成功時のみ）', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvmf-recover-'));
  try {
    // 前回の投稿失敗で notify-failed センチネルが残っている（認証切れ等の一時障害を想定）
    const sentinelPath = reviewArtifactPath(path.join(testDir, '.gh-maestro'), 7, '.incomplete');
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
    fs.writeFileSync(sentinelPath, JSON.stringify({ pr: 7, reason: 'notify-failed', postError: 'auth failed', validationErrors: ['bad'] }), 'utf8');

    const ghCalls = [];
    _setGhForTest((args) => { ghCalls.push(args); return { status: 0, stdout: 'https://github.com/x/pull/7#issuecomment-1\n' }; });
    process.env.NODE_TEST_CONTEXT = '1';
    try {
      const result = notifyManifestValidationFailure({
        manifest: { pr: 7, repo: 'owner/repo' },
        workspace: testDir,
        errors: ['bad'],
      });
      assert.equal(result.posted, true, 'notify-failed センチネルがあっても再投稿して回復する');
      assert.equal(result.skipped, false);
      assert.equal(ghCalls.length, 1);
      // 再投稿成功で「通知済み」センチネルに置き換わる
      const sentinel = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
      assert.equal(sentinel.reason, 'incomplete-review');
    } finally {
      delete process.env.NODE_TEST_CONTEXT;
    }
  } finally {
    _setGhForTest(null);
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test('notifyManifestValidationFailure: manifest.pr=0 でも例外で中断せず明確な失敗を返す（欠陥B）', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvmf-pr0-'));
  try {
    _setGhForTest((args) => { throw new Error('gh は呼ばれないはず'); });
    process.env.NODE_TEST_CONTEXT = '1';
    try {
      // 例外を投げずに戻ること自体が回帰検証（修正前は reviewArtifactPath が throw）
      let result;
      assert.doesNotThrow(() => {
        result = notifyManifestValidationFailure({
          manifest: { pr: 0, repo: 'o/r' },
          workspace: testDir,
          errors: ['pr must be a positive integer', 'coverage_ledger.leaves must be an array'],
        });
      });
      assert.equal(result.notifiable, false);
      assert.equal(result.posted, false);
      assert.ok(result.error && result.error.includes('通知先PRを特定できない'), `error should explain: ${result.error}`);
      assert.equal(result.sentinelPath, null);
    } finally {
      delete process.env.NODE_TEST_CONTEXT;
    }
  } finally {
    _setGhForTest(null);
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test('notifyManifestValidationFailure: manifest.pr欠落でも例外で中断しない（欠陥B）', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvmf-nopr-'));
  try {
    process.env.NODE_TEST_CONTEXT = '1';
    try {
      const manifest = { repo: 'o/r' }; // pr キー自体が無い
      let result;
      assert.doesNotThrow(() => {
        result = notifyManifestValidationFailure({ manifest, workspace: testDir, errors: ['pr must be a positive integer'] });
      });
      assert.equal(result.notifiable, false);
      assert.equal(result.posted, false);
      assert.equal(result.sentinelPath, null);
    } finally {
      delete process.env.NODE_TEST_CONTEXT;
    }
  } finally {
    _setGhForTest(null);
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test('notifyManifestValidationFailure: CLI --pr があれば manifest.pr 不正でも通知する（欠陥Bの回復）', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvmf-clipr-'));
  try {
    const ghCalls = [];
    _setGhForTest((args) => { ghCalls.push(args); return { status: 0, stdout: 'https://github.com/owner/repo/pull/42#issuecomment-9\n' }; });
    process.env.NODE_TEST_CONTEXT = '1';
    try {
      const result = notifyManifestValidationFailure({
        manifest: { pr: 0, repo: 'owner/repo' }, // manifestは不正でも、信頼できる起動コンテキストのprで通知できる
        workspace: testDir,
        errors: ['pr must be a positive integer'],
        pr: 42,
      });
      assert.equal(result.notifiable, true);
      assert.equal(result.posted, true);
      assert.equal(ghCalls.length, 1);
      assert.equal(ghCalls[0][2], '42', '通知先は CLI --pr を使う');
      // センチネルも PR 42 のパスに作られ、コメント本文のPR参照も通知先になる
      assert.ok(result.sentinelPath && result.sentinelPath.includes(path.join('pr', '42')));
      assert.equal(JSON.parse(fs.readFileSync(result.sentinelPath, 'utf8')).reason, 'incomplete-review');
    } finally {
      delete process.env.NODE_TEST_CONTEXT;
    }
  } finally {
    _setGhForTest(null);
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

// ── 追加対応（orchestrator指示）: --pr/--repo必須化と読み込み・パース失敗の通知統合 ──
// 積み残しだった「manifest JSONパース失敗」「読み込み失敗」も同じ通知経路（PRコメント＋
// センチネル）へ流す。manifest.pr / manifest.repo は取れないため、CLI --pr / --repo が通知先。

test('runJobsFromManifest: パース不能JSONでも通知投稿＋成功センチネルを作成する', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rjf-parse-'));
  try {
    const manifestPath = path.join(testDir, 'manifest.json');
    const resultsPath = path.join(testDir, 'results.json');
    // JSON.parse が SyntaxError になる文字列（モデルが書くJSONの構文エラーを模す）
    fs.writeFileSync(manifestPath, '{"pr": 42, "repo": "o/r", "jobs": [', 'utf8');

    const ghCalls = [];
    _setGhForTest((args) => { ghCalls.push(args); return { status: 0, stdout: 'https://github.com/o/r/pull/42#issuecomment-2\n' }; });
    process.env.NODE_TEST_CONTEXT = '1';
    try {
      const result = await runJobsFromManifest(manifestPath, resultsPath, testDir, 10000, 10000, '42', 'o/r');
      assert.equal(result.ok, false);
      assert.ok(result.summary.error.includes('manifest JSON parse failed'), `summary.error: ${result.summary.error}`);
      assert.ok(result.summary.notification, 'summaryに通知結果を含める');
      assert.equal(result.summary.notification.posted, true);
      assert.equal(result.summary.notification.notifiable, true);
      // 通知先は CLI --pr / --repo が使われる（manifestは読めないため manifest.pr/repo はない）
      assert.equal(ghCalls.length, 1);
      assert.equal(ghCalls[0][2], '42');
      assert.equal(ghCalls[0][4], 'o/r');
      // SyntaxError のメッセージ（V8のバリエーション: Unexpected token / in JSON at position /
      // Unexpected end of JSON input）と manifest パスが本文に載る
      const body = ghCalls[0][ghCalls[0].indexOf('--body') + 1];
      assert.match(body, /JSONを解析できませんでした/);
      assert.match(body, /Unexpected token|in JSON at position|Unexpected end of JSON input/);
      assert.ok(body.includes(manifestPath), '本文にmanifestパスを含める');
      // 成功センチネルが PR 42 のパスに作られる
      assert.ok(result.summary.notification.sentinelPath && result.summary.notification.sentinelPath.includes(path.join('pr', '42')));
      assert.equal(JSON.parse(fs.readFileSync(result.summary.notification.sentinelPath, 'utf8')).reason, 'incomplete-review');
    } finally {
      delete process.env.NODE_TEST_CONTEXT;
    }
  } finally {
    _setGhForTest(null);
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test('runJobsFromManifest: パース不能JSON＋投稿失敗はnotify-failedセンチネル（パースエラー）を書く', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rjf-parsefail-'));
  try {
    const manifestPath = path.join(testDir, 'manifest.json');
    const resultsPath = path.join(testDir, 'results.json');
    fs.writeFileSync(manifestPath, 'not json at all', 'utf8');

    _setGhForTest(() => ({ status: 1, stdout: '', stderr: 'auth failed: token expired' }));
    process.env.NODE_TEST_CONTEXT = '1';
    try {
      const result = await runJobsFromManifest(manifestPath, resultsPath, testDir, 10000, 10000, '42', 'o/r');
      assert.equal(result.ok, false);
      const notif = result.summary.notification;
      assert.equal(notif.posted, false);
      assert.ok(notif.error && notif.error.includes('auth failed'));
      // 成功センチネルではなく、失敗内容を持つ notify-failed センチネル
      const sentinel = JSON.parse(fs.readFileSync(notif.sentinelPath, 'utf8'));
      assert.equal(sentinel.reason, 'notify-failed');
      assert.equal(sentinel.failureLabel, 'パースエラー');
      assert.ok(sentinel.failureDetail.includes('manifest JSON parse failed'), `failureDetail: ${sentinel.failureDetail}`);
      // V8のSyntaxErrorメッセージはバージョンにより文言が異なる（Unexpected token / in JSON at position /
      // is not valid JSON 等）。通知ロジックが e.message をそのまま運んでいることだけを検証する
      assert.match(sentinel.failureDetail, /Unexpected token|in JSON at position|is not valid JSON/,
        `SyntaxErrorメッセージを含む: ${sentinel.failureDetail}`);
      assert.ok(sentinel.failureDetail.includes(manifestPath), 'failureDetailにmanifestパスを含める');
    } finally {
      delete process.env.NODE_TEST_CONTEXT;
    }
  } finally {
    _setGhForTest(null);
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test('runJobsFromManifest: manifest読み込み失敗も通知投稿＋センチネルを作成する', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rjf-read-'));
  try {
    const manifestPath = path.join(testDir, 'no-such-manifest.json');
    const resultsPath = path.join(testDir, 'results.json');

    const ghCalls = [];
    _setGhForTest((args) => { ghCalls.push(args); return { status: 0, stdout: 'url\n' }; });
    process.env.NODE_TEST_CONTEXT = '1';
    try {
      const result = await runJobsFromManifest(manifestPath, resultsPath, testDir, 10000, 10000, '42', 'o/r');
      assert.equal(result.ok, false);
      assert.ok(result.summary.error.includes('manifest read failed'), `summary.error: ${result.summary.error}`);
      assert.equal(result.summary.notification.posted, true);
      assert.equal(ghCalls.length, 1);
      const body = ghCalls[0][ghCalls[0].indexOf('--body') + 1];
      assert.match(body, /読み込めませんでした/);
      assert.ok(body.includes(manifestPath), '本文にmanifestパスを含める');
      assert.equal(JSON.parse(fs.readFileSync(result.summary.notification.sentinelPath, 'utf8')).reason, 'incomplete-review');
    } finally {
      delete process.env.NODE_TEST_CONTEXT;
    }
  } finally {
    _setGhForTest(null);
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test('notifyManifestProblem: pr欠落（プログラム呼び出しのみ）は例外で中断せず notifiable:false', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nmp-nopr-'));
  try {
    _setGhForTest((args) => { throw new Error('gh は呼ばれないはず'); });
    process.env.NODE_TEST_CONTEXT = '1';
    try {
      let result;
      assert.doesNotThrow(() => {
        result = notifyManifestProblem({
          workspace: testDir,
          pr: undefined,
          repo: 'o/r',
          commentBody: 'body',
          failureLabel: 'パースエラー',
          failureDetail: 'x',
        });
      });
      assert.equal(result.notifiable, false);
      assert.equal(result.posted, false);
      assert.equal(result.sentinelPath, null);
    } finally {
      delete process.env.NODE_TEST_CONTEXT;
    }
  } finally {
    _setGhForTest(null);
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test('buildManifestLoadFailureComment: パース失敗の本文に SyntaxError メッセージとmanifestパスを含める', () => {
  const body = buildManifestLoadFailureComment('parse', 'Unexpected token } in JSON at position 12', '/wt/records/pr/42/review/manifest.json', '42');
  assert.match(body, /PR #42/);
  assert.match(body, /JSONを解析できませんでした/);
  assert.match(body, /Unexpected token } in JSON at position 12/);
  assert.ok(body.includes('/wt/records/pr/42/review/manifest.json'));
  const readBody = buildManifestLoadFailureComment('read', 'ENOENT: no such file', '/x/manifest.json', '42');
  assert.match(readBody, /読み込めませんでした/);
  assert.match(readBody, /ENOENT: no such file/);
});

test('CLI: --pr / --repo は必須で、欠落・不正は作業前に exit 2（クラッシュさせない）', () => {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'run-review-jobs.js');
  const baseArgs = ['--manifest', 'm.json', '--results', 'r.json'];
  const run = (args) => spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    env: cleanSpawnEnv(),
  });

  // --pr 欠落 → exit 2 の明確なメッセージ（parseFlags は欠落値を null で返すため、
  // null.trim() 等の TypeError クラッシュにしないことが本テストの趣旨）
  const noPr = run([...baseArgs, '--repo', 'o/r']);
  assert.equal(noPr.status, 2, `--pr 欠落は exit 2: ${noPr.stderr}`);
  assert.match(noPr.stderr, /--pr は必須です/);

  // --pr 不正（非正整数）→ exit 2
  const badPr = run([...baseArgs, '--pr', 'abc', '--repo', 'o/r']);
  assert.equal(badPr.status, 2, `--pr 不正は exit 2: ${badPr.stderr}`);
  assert.match(badPr.stderr, /--pr は正整数でなければなりません/);

  // --repo 欠落 → exit 2（null.trim() の TypeError クラッシュで exit 1 にならないこと）
  const noRepo = run([...baseArgs, '--pr', '42']);
  assert.equal(noRepo.status, 2, `--repo 欠落は exit 2（クラッシュではない）: ${noRepo.stderr}`);
  assert.match(noRepo.stderr, /--repo は必須です/);
  assert.doesNotMatch(noRepo.stderr, /TypeError/);
});

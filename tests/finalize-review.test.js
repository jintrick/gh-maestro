const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  checkCompleteness,
  aggregateFindings,
  buildIncompleteComment,
  writeSentinel,
  finalizeReview,
  _setGhForTest,
} = require('../scripts/finalize-review');

const { ALL_LEAF_IDS, TRUNK_TO_LEAVES } = require('../scripts/shared/review-aspects');

test('checkCompleteness: all adopted leaves success passes', () => {
  const coverageLedger = {
    leaves: ALL_LEAF_IDS.map(id => ({
      id,
      trunk: Object.entries(TRUNK_TO_LEAVES).find(([, lvs]) => lvs.includes(id))[0],
      decision: 'adopted',
      rationale: null,
    })),
  };
  const jobResults = ALL_LEAF_IDS.map((id, i) => ({
    id: 'job-' + i,
    status: 'success',
    leaf_ids: [id],
    findings: [],
  }));
  const result = checkCompleteness(coverageLedger, jobResults);
  assert.equal(result.passed, true, 'failures: ' + result.failures.join('; '));
});

test('checkCompleteness: missing leaf from ledger fails', () => {
  const coverageLedger = {
    leaves: [{ id: 'correctness/logic-invariants', trunk: 'Correctness', decision: 'adopted', rationale: null }],
  };
  const result = checkCompleteness(coverageLedger, []);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(f => f.includes('missing from coverage ledger')));
});

test('checkCompleteness: adopted leaf with only failed job fails', () => {
  const coverageLedger = {
    leaves: [{ id: 'correctness/logic-invariants', trunk: 'Correctness', decision: 'adopted', rationale: null }],
  };
  const jobResults = [{ id: 'job-1', status: 'failed', leaf_ids: ['correctness/logic-invariants'], error: 'timeout' }];
  const result = checkCompleteness(coverageLedger, jobResults);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(f => f.includes('not assigned to any job') || f.includes('only failed')));
});

test('checkCompleteness: excluded leaf with rationale is ok', () => {
  const coverageLedger = {
    leaves: ALL_LEAF_IDS.map(id => ({
      id,
      trunk: Object.entries(TRUNK_TO_LEAVES).find(([, lvs]) => lvs.includes(id))[0],
      decision: id === 'maintainability/test-quality' ? 'excluded' : 'adopted',
      rationale: id === 'maintainability/test-quality' ? 'no test changes in diff' : null,
    })),
  };
  const adoptedLeaves = ALL_LEAF_IDS.filter(id => id !== 'maintainability/test-quality');
  const jobResults = adoptedLeaves.map((id, i) => ({
    id: 'job-' + i,
    status: 'success',
    leaf_ids: [id],
    findings: [],
  }));
  const result = checkCompleteness(coverageLedger, jobResults);
  assert.equal(result.passed, true, 'failures: ' + result.failures.join('; '));
});

test('checkCompleteness: excluded leaf without rationale fails', () => {
  const coverageLedger = {
    leaves: ALL_LEAF_IDS.map(id => ({
      id,
      trunk: Object.entries(TRUNK_TO_LEAVES).find(([, lvs]) => lvs.includes(id))[0],
      decision: id === 'maintainability/test-quality' ? 'excluded' : 'adopted',
      rationale: null,
    })),
  };
  const adoptedLeaves = ALL_LEAF_IDS.filter(id => id !== 'maintainability/test-quality');
  const jobResults = adoptedLeaves.map((id, i) => ({
    id: 'job-' + i,
    status: 'success',
    leaf_ids: [id],
    findings: [],
  }));
  const result = checkCompleteness(coverageLedger, jobResults);
  assert.equal(result.passed, false);
});

test('checkCompleteness: trunk with unaccounted leaf fails', () => {
  const coverageLedger = {
    leaves: [
      { id: 'correctness/logic-invariants', trunk: 'Correctness', decision: 'adopted', rationale: null },
      { id: 'correctness/api-contract', trunk: 'Correctness', decision: 'adopted', rationale: null },
      { id: 'correctness/concurrency', trunk: 'Correctness', decision: 'adopted', rationale: null },
    ],
  };
  const jobResults = [
    { id: 'job-1', status: 'success', leaf_ids: ['correctness/logic-invariants'], findings: [] },
  ];
  const result = checkCompleteness(coverageLedger, jobResults);
  assert.equal(result.passed, false);
});

test('aggregateFindings merges findings from all success jobs', () => {
  const results = {
    manifest_ref: { pr: 1, repo: 'o/r', headRefOid: 'abc' },
    jobs: [
      { id: 'job-1', status: 'success', leaf_ids: ['l1'], findings: [{ aspect: 'Correctness', path: 'a.ts', line_anchor: 'x', summary: 's1', severity: 'MAJOR', severity_rationale: 'r', body: 'b', verified_references: ['a.ts'] }] },
      { id: 'job-2', status: 'success', leaf_ids: ['l2'], findings: [{ aspect: 'Maintainability', path: 'b.ts', line_anchor: 'y', summary: 's2', severity: 'SUGGESTION', severity_rationale: 'r', body: 'b', verified_references: ['b.ts'] }] },
      { id: 'job-3', status: 'failed', leaf_ids: ['l3'], error: 'timeout' },
    ],
  };
  const payload = aggregateFindings(results);
  assert.equal(payload.pr, 1);
  assert.equal(payload.findings.length, 2);
});

test('buildIncompleteComment includes success, failure, and excluded sections', () => {
  const results = {
    manifest_ref: { pr: 5, repo: 'o/r', headRefOid: 'abc' },
    coverage_ledger: {
      leaves: [
        { id: 'correctness/logic-invariants', trunk: 'Correctness', decision: 'adopted', rationale: null },
        { id: 'correctness/api-contract', trunk: 'Correctness', decision: 'excluded', rationale: 'API no change' },
      ],
    },
    jobs: [
      { id: 'job-1', status: 'success', leaf_ids: ['correctness/logic-invariants'], findings: [] },
    ],
  };
  const gateResult = {
    passed: false,
    failures: ['leaf correctness/api-contract missing'],
    successLeaves: ['correctness/logic-invariants'],
    failedLeaves: ['correctness/api-contract'],
    excludedLeaves: [],
  };
  const comment = buildIncompleteComment(results, gateResult);
  assert.match(comment, /不完全/);
  assert.match(comment, /logic-invariants/);
  assert.match(comment, /0件の所見/);
  assert.match(comment, /leaf correctness\/api-contract missing/);
});

test('buildIncompleteComment: 成功ジョブの指摘内容を含む（Issue #273）', () => {
  const finding = {
    aspect: 'Correctness',
    path: 'src/foo.ts',
    line_anchor: 'await save(user)',
    summary: '永続化が成功を返す前に失われる',
    severity: 'MAJOR',
    severity_rationale: 'API成功後に永続化失敗するとデータ損失',
    body: '## 観測した事実\n\n永続化前に成功を返す。\n\n## 放置すると何が起きるか\n\nデータ損失。',
    verified_references: ['src/foo.ts', 'src/userRepo.ts'],
  };
  const results = {
    manifest_ref: { pr: 5, repo: 'o/r', headRefOid: 'abc' },
    coverage_ledger: {
      leaves: [
        { id: 'correctness/logic-invariants', trunk: 'Correctness', decision: 'adopted', rationale: null },
        { id: 'correctness/api-contract', trunk: 'Correctness', decision: 'adopted', rationale: null },
      ],
    },
    jobs: [
      { id: 'job-1', status: 'success', leaf_ids: ['correctness/logic-invariants'], findings: [finding] },
      { id: 'job-2', status: 'failed', leaf_ids: ['correctness/api-contract'], error: 'timeout' },
    ],
  };
  const gateResult = {
    passed: false,
    failures: ['adopted leaf correctness/api-contract has only failed job results'],
    successLeaves: ['correctness/logic-invariants'],
    failedLeaves: ['correctness/api-contract'],
    excludedLeaves: [],
  };
  const comment = buildIncompleteComment(results, gateResult);
  assert.match(comment, /最後の実行で成功したジョブの指摘/);
  assert.match(comment, /MAJOR/);
  assert.match(comment, /Correctness/);
  assert.match(comment, /src\/foo\.ts/);
  assert.match(comment, /永続化が成功を返す前に失われる/);
  assert.match(comment, /await save\(user\)/);
  assert.match(comment, /データ損失/);
  assert.match(comment, /src\/userRepo\.ts/);
});

test('buildIncompleteComment: 成功ジョブのfindingsが無ければ指摘セクションを出さない', () => {
  const results = {
    manifest_ref: { pr: 5, repo: 'o/r', headRefOid: 'abc' },
    coverage_ledger: {
      leaves: [
        { id: 'correctness/logic-invariants', trunk: 'Correctness', decision: 'adopted', rationale: null },
      ],
    },
    jobs: [
      { id: 'job-1', status: 'success', leaf_ids: ['correctness/logic-invariants'], findings: [] },
    ],
  };
  const gateResult = {
    passed: false,
    failures: [],
    successLeaves: ['correctness/logic-invariants'],
    failedLeaves: [],
    excludedLeaves: [],
  };
  const comment = buildIncompleteComment(results, gateResult);
  assert.doesNotMatch(comment, /最後の実行で成功したジョブの指摘/);
});

test('writeSentinel creates .incomplete file', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmsl-'));
  try {
    const ghDir = path.join(tmpDir, '.gh-maestro');
    fs.mkdirSync(ghDir, { recursive: true });
    const sentinelPath = path.join(ghDir, 'records', 'pr', '5', 'review', 'manager.incomplete');
    const result = writeSentinel(tmpDir, 5);
    assert.ok(result);
    assert.ok(fs.existsSync(sentinelPath));
    const content = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
    assert.equal(content.pr, 5);
    assert.equal(content.reason, 'incomplete-review');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('finalizeReview(incomplete): 投稿失敗時に notify-failed センチネルを書く（Issue #273 レビュー指摘）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-nf-'));
  try {
    const resultsPath = path.join(tmpDir, 'results.json');
    const results = {
      manifest_ref: { pr: 5, repo: 'o/r', headRefOid: 'abc' },
      coverage_ledger: {
        leaves: [
          { id: 'correctness/logic-invariants', trunk: 'Correctness', decision: 'adopted', rationale: null },
        ],
      },
      jobs: [
        { id: 'job-1', status: 'success', leaf_ids: ['correctness/logic-invariants'], findings: [] },
      ],
    };
    fs.writeFileSync(resultsPath, JSON.stringify(results), 'utf8');

    _setGhForTest(() => ({ status: 1, stdout: '', stderr: 'auth failed: token expired' }));
    try {
      const res = await finalizeReview(resultsPath, 'incomplete', null, tmpDir);
      assert.equal(res.ok, false);
      assert.match(res.summary.error, /plane comment post failed/);
      // センチネルは「通知済みの不完全完了」ではなく notify-failed（監督側が exit 1 で扱う）
      const sentinelPath = path.join(tmpDir, '.gh-maestro', 'records', 'pr', '5', 'review', 'manager.incomplete');
      assert.ok(fs.existsSync(sentinelPath), 'notify-failed センチネルが書かれる');
      const sentinel = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
      assert.equal(sentinel.reason, 'notify-failed');
      assert.match(sentinel.postError, /auth failed/);
      assert.equal(sentinel.failureLabel, '不完全レビュー通知');
    } finally {
      _setGhForTest(null);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('finalizeReview(incomplete): 投稿成功時は incomplete-review センチネルを書く', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-ok-'));
  try {
    const resultsPath = path.join(tmpDir, 'results.json');
    const results = {
      manifest_ref: { pr: 5, repo: 'o/r', headRefOid: 'abc' },
      coverage_ledger: {
        leaves: [
          { id: 'correctness/logic-invariants', trunk: 'Correctness', decision: 'adopted', rationale: null },
        ],
      },
      jobs: [
        { id: 'job-1', status: 'success', leaf_ids: ['correctness/logic-invariants'], findings: [] },
      ],
    };
    fs.writeFileSync(resultsPath, JSON.stringify(results), 'utf8');

    _setGhForTest(() => ({ status: 0, stdout: 'https://github.com/comment-url\n', stderr: '' }));
    try {
      const res = await finalizeReview(resultsPath, 'incomplete', null, tmpDir);
      assert.equal(res.ok, true);
      const sentinelPath = path.join(tmpDir, '.gh-maestro', 'records', 'pr', '5', 'review', 'manager.incomplete');
      const sentinel = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
      assert.equal(sentinel.reason, 'incomplete-review');
    } finally {
      _setGhForTest(null);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── finalizeReview(complete) with --integrated（RMフェーズ2の重複統合ドラフト） ──

// validatePayload は workspace/scripts/review-findings-schema.json からスキーマを読むため、
// テストの一時workspaceへ実スキーマをコピーする。
function copySchemaToWorkspace(workspace) {
  const scriptsDir = path.join(workspace, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  const src = path.join(__dirname, '..', 'scripts', 'review-findings-schema.json');
  fs.copyFileSync(src, path.join(scriptsDir, 'review-findings-schema.json'));
}

function completeGateResults() {
  return {
    manifest_ref: { pr: 5, repo: 'o/r', headRefOid: 'abc' },
    coverage_ledger: {
      leaves: ALL_LEAF_IDS.map(id => ({
        id,
        trunk: Object.entries(TRUNK_TO_LEAVES).find(([, lvs]) => lvs.includes(id))[0],
        decision: 'adopted',
        rationale: null,
      })),
    },
    jobs: ALL_LEAF_IDS.map((id, i) => ({
      id: 'job-' + i,
      status: 'success',
      leaf_ids: [id],
      findings: [],
    })),
  };
}

test('finalizeReview(complete, --integrated): 統合ドラフトのfindingsを出力に書き出す', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-int-'));
  copySchemaToWorkspace(tmpDir);
  try {
    const resultsPath = path.join(tmpDir, 'results.json');
    fs.writeFileSync(resultsPath, JSON.stringify(completeGateResults()), 'utf8');

    // RMフェーズ2が重複を畳んだ統合ドラフト
    const draftPath = path.join(tmpDir, 'draft.json');
    const integratedFindings = [
      {
        aspect: 'Correctness', path: 'src/foo.ts', line_anchor: 'await save(u)',
        summary: '永続化が成功を返す前に失われる', severity: 'MAJOR', severity_rationale: 'r',
        body: 'b', verified_references: ['src/foo.ts'],
      },
    ];
    fs.writeFileSync(draftPath, JSON.stringify({ findings: integratedFindings }), 'utf8');

    const outputPath = path.join(tmpDir, 'manager.json');
    const res = await finalizeReview(resultsPath, 'complete', outputPath, tmpDir, draftPath);
    assert.equal(res.ok, true);
    assert.equal(res.summary.totalFindings, 1);
    const out = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.equal(out.pr, 5);
    assert.equal(out.repo, 'o/r');
    assert.equal(out.headRefOid, 'abc');
    // 統合ドラフトのfindingsがそのまま使われる
    assert.equal(out.findings.length, 1);
    assert.equal(out.findings[0].summary, '永続化が成功を返す前に失われる');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('finalizeReview(complete, --integrated): ドラフトがfindings配列を持たなければエラーで書き出さない', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-int-bad-'));
  copySchemaToWorkspace(tmpDir);
  try {
    const resultsPath = path.join(tmpDir, 'results.json');
    fs.writeFileSync(resultsPath, JSON.stringify(completeGateResults()), 'utf8');

    const draftPath = path.join(tmpDir, 'draft.json');
    fs.writeFileSync(draftPath, JSON.stringify({ nope: true }), 'utf8'); // findings配列なし

    const outputPath = path.join(tmpDir, 'manager.json');
    const res = await finalizeReview(resultsPath, 'complete', outputPath, tmpDir, draftPath);
    assert.equal(res.ok, false);
    assert.match(res.summary.error, /findings array/);
    assert.ok(!fs.existsSync(outputPath), '不正ドラフトでは出力を書かない');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('finalizeReview(complete, --integrated): ドラフトがJSONパース不能ならエラーで書き出さない', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-int-parse-'));
  copySchemaToWorkspace(tmpDir);
  try {
    const resultsPath = path.join(tmpDir, 'results.json');
    fs.writeFileSync(resultsPath, JSON.stringify(completeGateResults()), 'utf8');

    const draftPath = path.join(tmpDir, 'draft.json');
    fs.writeFileSync(draftPath, 'not json{{{', 'utf8');

    const outputPath = path.join(tmpDir, 'manager.json');
    const res = await finalizeReview(resultsPath, 'complete', outputPath, tmpDir, draftPath);
    assert.equal(res.ok, false);
    assert.match(res.summary.error, /draft JSON parse failed/);
    assert.ok(!fs.existsSync(outputPath));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

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

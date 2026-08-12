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
} = require('../scripts/run-review-jobs');

const { ALL_LEAF_IDS, TRUNK_TO_LEAVES } = require('../scripts/shared/review-aspects');

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

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

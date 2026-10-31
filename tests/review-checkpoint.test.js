'use strict';
const { test, after } = require('node:test');
const { createTempDirScope } = require('../scripts/shared/temp-directory');
const scope = createTempDirScope();
after(() => scope.cleanup());
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const checkpoint = require('../scripts/shared/review-checkpoint');
const validate = value => ({ valid: !!value && Array.isArray(value.jobs) });
const manifest = { pr: 11, repo: 'o/r', headRefOid: 'abc', jobs: [{ id: 'a', leaf_ids: ['x'] }] };

test('review checkpoints preserve prior runs and restore completed jobs and attempts', () => {
  const ws = scope.mkdtemp('rm-checkpoint-');
  try {
    assert.equal(checkpoint.load(ws, 11, validate), null);
    const first = checkpoint.create(ws, 11, manifest, validate);
    first.state.attempts = 1;
    first.state.results.a = { jobId: 'a', status: 'success', leaf_ids: ['x'], attempt: 1, findings: [] };
    checkpoint.save(first.file, first.state, validate);
    assert.deepEqual(checkpoint.load(ws, 11, validate).state, first.state);
    const second = checkpoint.create(ws, 11, manifest, validate);
    assert.notEqual(first.file, second.file);
    assert.equal(checkpoint.load(ws, 11, validate).state.attempts, 0);
    assert.equal(checkpoint.read(ws, 11, first.id, validate).state.results.a.status, 'success');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('review checkpoint rejects parse errors, invalid types and read failures without repair', () => {
  const ws = scope.mkdtemp('rm-checkpoint-');
  try {
    const entry = checkpoint.create(ws, 11, manifest, validate);
    for (const contents of ['{', JSON.stringify({ version: 1, manifest, attempts: '1', results: {} })]) {
      fs.writeFileSync(entry.file, contents);
      assert.throws(() => checkpoint.load(ws, 11, validate), error => error.message.includes(entry.file));
      assert.equal(fs.readFileSync(entry.file, 'utf8'), contents);
    }
    fs.rmSync(entry.file);
    fs.mkdirSync(entry.file);
    assert.throws(() => checkpoint.load(ws, 11, validate), error => error.message.includes(entry.file));
    assert.equal(fs.statSync(entry.file).isDirectory(), true);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

const { runJobsFromManifest, validateManifest, ALL_LEAF_IDS, TRUNK_TO_LEAVES, _setFinalizeReviewForTest } = require('../scripts/run-review-jobs');
function validManifest() {
  return {
    pr: 11, repo: 'o/r', headRefOid: 'abc', changedFiles: ['a.js'],
    coverage_ledger: { leaves: ALL_LEAF_IDS.map(id => ({
      id, trunk: Object.entries(TRUNK_TO_LEAVES).find(([, ids]) => ids.includes(id))[0],
      decision: 'adopted', rationale: null,
    })) },
    jobs: [{ id: 'a', leaf_ids: [...ALL_LEAF_IDS], aspect: 'Correctness' }], parallelism: 'parallel',
  };
}
test('completed checkpoint is merged without consuming another attempt', async () => {
  const ws = scope.mkdtemp('rm-completed-');
  try {
    const plan = validManifest();
    const entry = checkpoint.create(ws, 11, plan, validateManifest);
    entry.state.attempts = 2;
    entry.state.results.a = { jobId: 'a', status: 'success', leaf_ids: plan.jobs[0].leaf_ids, attempt: 1, findings: [] };
    checkpoint.save(entry.file, entry.state, validateManifest);
    const manifestFile = path.join(ws, 'manifest.json');
    const resultFile = path.join(ws, 'results.json');
    fs.writeFileSync(manifestFile, JSON.stringify(plan));
    const result = await runJobsFromManifest(manifestFile, resultFile, ws, 1000, 1000, '11', 'o/r', path.join(ws, '.gh-maestro'), { mainWorkspace: ws, checkpointId: entry.id, readDeclarationEvidence: () => ({ status: 'absent', head: '0'.repeat(40) }) });
    assert.equal(result.ok, true, JSON.stringify(result.summary));
    assert.equal(JSON.parse(fs.readFileSync(resultFile)).jobs[0].jobId, 'a');
    assert.equal(checkpoint.read(ws, 11, entry.id, validateManifest).state.attempts, 2);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('resume refuses pending jobs after the attempt limit', async () => {
  const ws = scope.mkdtemp('rm-limit-');
  try {
    const plan = validManifest();
    plan.jobs = [
      { id: 'a', leaf_ids: [ALL_LEAF_IDS[0]], aspect: 'Correctness' },
      { id: 'b', leaf_ids: ALL_LEAF_IDS.slice(1), aspect: 'Correctness' },
    ];
    const entry = checkpoint.create(ws, 11, plan, validateManifest);
    entry.state.attempts = 2;
    entry.state.results.a = { jobId: 'a', status: 'success', leaf_ids: plan.jobs[0].leaf_ids, attempt: 1, findings: [] };
    checkpoint.save(entry.file, entry.state, validateManifest);
    const manifestFile = path.join(ws, 'manifest.json');
    fs.writeFileSync(manifestFile, JSON.stringify(plan));
    let restored;
    _setFinalizeReviewForTest(async resultsPath => { restored = JSON.parse(fs.readFileSync(resultsPath, 'utf8')); return { ok: true }; });
    const result = await runJobsFromManifest(manifestFile, path.join(ws, 'results.json'), ws, 1000, 1000, '11', 'o/r', path.join(ws, '.gh-maestro'), { mainWorkspace: ws, checkpointId: entry.id, readDeclarationEvidence: () => ({ status: 'absent', head: '0'.repeat(40) }) });
    assert.equal(result.summary.retryLimitReached, true);
    assert.equal(restored.jobs[0].status, 'success');
    assert.equal(restored.jobs[0].jobId, 'a');
    assert.equal(restored.jobs[1].status, 'failed');
    assert.equal(restored.jobs[1].jobId, 'b');
    assert.equal(restored.manifest_ref.headRefOid, 'abc');
    assert.equal(checkpoint.read(ws, 11, entry.id, validateManifest).state.attempts, 2);
  } finally { _setFinalizeReviewForTest(null); fs.rmSync(ws, { recursive: true, force: true }); }
});

test('resume selects only the same PR, repository and HEAD, preserving older runs', () => {
  const ws = scope.mkdtemp('rm-select-');
  const entry = checkpoint.create(ws, 11, validManifest(), validateManifest);
  assert.equal(checkpoint.select(ws, 11, 'o/r', 'abc', validateManifest).id, entry.id);
  assert.equal(checkpoint.select(ws, 11, 'o/r', 'changed', validateManifest), null);
  assert.throws(() => checkpoint.select(ws, 11, 'other/repo', 'abc', validateManifest), /PR\/repo/);
  checkpoint.begin(ws, 11);
  assert.equal(checkpoint.select(ws, 11, 'o/r', 'abc', validateManifest), null);
  assert.ok(fs.existsSync(entry.file));
});

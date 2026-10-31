'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createTempDirScope } = require('../../scripts/shared/temp-directory');
const checkpoint = require('../../scripts/shared/review-checkpoint');
const processLiveness = require('../../scripts/shared/process-liveness');
const { validateManifest, ALL_LEAF_IDS, TRUNK_TO_LEAVES } = require('../../scripts/run-review-jobs');
const { buildReviewManagerLaunchSpec } = require('../../scripts/shared/worker-factory');

const root = path.resolve(__dirname, '../..');
const worker = path.join(root, 'tests/fixtures/review-resume-worker.js');
function command(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  assert.equal(r.status, 0, `${cmd}: ${r.stderr || r.error}`);
  return r.stdout.trim();
}
function plan(head) {
  const leaves = ALL_LEAF_IDS.map(id => ({ id, trunk: Object.entries(TRUNK_TO_LEAVES).find(([, ids]) => ids.includes(id))[0], decision: 'adopted', rationale: null }));
  return { pr: 11, repo: 'o/r', headRefOid: head, changedFiles: ['fixture.txt'], coverage_ledger: { leaves },
    jobs: [{ id: 'first', leaf_ids: [ALL_LEAF_IDS[0]], aspect: 'Correctness' }, { id: 'second', leaf_ids: ALL_LEAF_IDS.slice(1), aspect: 'Correctness' }], parallelism: 'parallel' };
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitUntil(predicate, label) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) { if (predicate()) return; await delay(100); }
  throw new Error(`timeout: ${label}`);
}
async function cleanupTempScope(scope) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      scope.cleanup();
      return;
    } catch (error) {
      if (error?.cause?.code !== 'EBUSY' || attempt === 2) throw error;
      // Windows can keep a just-closed process CWD busy briefly after its
      // liveness endpoint is released. Retry this bounded temp-file cleanup.
      await delay(1000);
    }
  }
}
async function scenario(mode) {
  // Git worktree handles may remain briefly busy after the manager endpoint closes on Windows.
  const scope = createTempDirScope({ retryDelay: 1000 });
  const base = scope.mkdtemp('rm-resume-integration-');
  const ws = path.join(base, 'workspace');
  const remote = path.join(base, 'remote.git');
  const home = path.join(base, 'home');
  const fixture = path.join(base, 'fixture');
  const runtimeRoot = path.join(base, 'runtime');
  fs.mkdirSync(ws, { recursive: true }); fs.mkdirSync(fixture, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, GH_MAESTRO_WORKSPACE: ws,
    GH_MAESTRO_RUNTIME_DIR: runtimeRoot, REVIEW_RESUME_FIXTURE: fixture, GH_HOST: '127.0.0.1' };
  delete env.NODE_TEST_CONTEXT;
  let safeToCleanup = true;
  try {
    command('git', ['init', ws], { env });
    command('git', ['-C', ws, 'config', 'user.name', 'Fixture'], { env });
    command('git', ['-C', ws, 'config', 'user.email', 'fixture@example.invalid'], { env });
    fs.writeFileSync(path.join(ws, 'fixture.txt'), 'fixture\n');
    command('git', ['-C', ws, 'add', 'fixture.txt'], { env });
    command('git', ['-C', ws, 'commit', '-m', 'fixture'], { env });
    const head = command('git', ['-C', ws, 'rev-parse', 'HEAD'], { env });
    command('git', ['init', '--bare', remote], { env });
    command('git', ['-C', ws, 'remote', 'add', 'origin', remote], { env });
    command('git', ['-C', ws, 'push', 'origin', 'HEAD:refs/pull/11/head'], { env });
    const config = path.join(home, '.gh-maestro');
    fs.mkdirSync(config, { recursive: true });
    fs.writeFileSync(path.join(config, 'config.json'), JSON.stringify({ skillAgentMap: { 'gh-maestro-reviewer': 'claude' }, agents: { claude: { command: process.execPath, extraArgs: [worker], nonInteractiveTokens: [], promptDelivery: 'positional' } } }));
    fs.cpSync(path.join(root, 'skills/gh-maestro-reviewer'), path.join(config, 'skills/gh-maestro-reviewer'), { recursive: true });
    const skill = path.join(home, '.claude/skills/gh-maestro-reviewer');
    fs.mkdirSync(skill, { recursive: true }); fs.writeFileSync(path.join(skill, 'SKILL.md'), 'fixture');
    const original = plan(mode === 'head-change' ? 'different-head' : head);
    fs.writeFileSync(path.join(fixture, 'plan.json'), JSON.stringify(plan(head)));
    const saved = checkpoint.create(ws, 11, original, validateManifest);
    saved.state.attempts = 1;
    saved.state.results.first = { jobId: 'first', status: 'success', leaf_ids: original.jobs[0].leaf_ids, attempt: 1, findings: [] };
    checkpoint.save(saved.file, saved.state, validateManifest);
    const oldWorktree = path.join(ws, '.gh-maestro/worktrees/review-pr-11');
    fs.mkdirSync(oldWorktree, { recursive: true }); fs.writeFileSync(path.join(oldWorktree, 'old-marker'), 'old');
    const args = [path.join(root, 'scripts/start-review-manager.js'), ...(mode === 'fresh' ? [] : ['--resume']), '11', 'o/r', ws, '1'];
    command(process.execPath, args, { env });
    safeToCleanup = false;
    const runningPath = path.join(ws, '.gh-maestro/records/pr/11/review/manager.running');
    await waitUntil(() => fs.existsSync(runningPath), 'manager registration');
    const checker = processLiveness.createLiveness({ runtimeRoot: () => runtimeRoot });
    const managerRef = checker.readRef(JSON.parse(fs.readFileSync(runningPath, 'utf8')));
    assert.ok(managerRef, 'manager.running has a process identity');
    const resultPath = path.join(fixture, 'observed-results.json');
    await waitUntil(() => fs.existsSync(resultPath), 'phase2 results');
    const results = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    const events = fs.readFileSync(path.join(fixture, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(fs.existsSync(path.join(oldWorktree, 'old-marker')), false);
    assert.deepEqual(results.jobs.map(j => j.jobId), ['first', 'second']);
    assert.ok(results.jobs.every(j => j.status === 'success'));
    assert.equal(events.filter(e => e.kind === 'phase1').length, mode === 'resume' ? 0 : 1);
    const jobs = events.filter(e => e.kind === 'job').map(e => e.id);
    assert.deepEqual(jobs.sort(), mode === 'resume' ? ['second'] : ['first', 'second']);
    await waitUntil(() => !fs.existsSync(runningPath), 'manager exit');
    await waitUntil(() => checker.observe(managerRef) === 'dead', 'Review Manager process exit');
    // The headless shim owns the workspace cwd and the open log fd until its exit hook
    // has run and it exits. Wait for its liveness resource (same key the launcher gave it),
    // not a timeout, so cleanup never races the shim or its exit hook.
    const shimWorkerName = buildReviewManagerLaunchSpec({ issue: 1, pr: 11, repo: 'o/r', workspace: ws }).workerName;
    const shimResource = { workspace: ws, kind: 'worker', name: shimWorkerName };
    await waitUntil(() => checker.observeResource(shimResource).state === 'dead', 'headless shim and exit hook exit');
    safeToCleanup = true;
  } finally { if (safeToCleanup) await cleanupTempScope(scope); }
}
for (const mode of ['resume', 'fresh', 'head-change']) {
  test(`start-review-manager ${mode} carries review state through worktree recreation`, { timeout: 120000 }, async () => scenario(mode));
}

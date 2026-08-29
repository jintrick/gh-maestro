'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  TEST_RESULT_PRODUCER,
  TEST_RESULT_PROVENANCE,
  parseTapSummary,
  testResultPath,
  validateTestResultArtifact,
  writeTestResultArtifact,
  readTestResultArtifact,
} = require('../scripts/shared/test-result');
const { runtimeRoot, workspaceRuntimeDir } = require('../scripts/shared/storage-layout');

const savedRuntimeDir = process.env.GH_MAESTRO_RUNTIME_DIR;
const isolatedRuntimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-result-runtime-'));
process.env.GH_MAESTRO_RUNTIME_DIR = isolatedRuntimeDir;

process.on('exit', () => {
  if (savedRuntimeDir === undefined) delete process.env.GH_MAESTRO_RUNTIME_DIR;
  else process.env.GH_MAESTRO_RUNTIME_DIR = savedRuntimeDir;
  try { fs.rmSync(isolatedRuntimeDir, { recursive: true, force: true }); } catch {}
});

function tempWorktree() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-result-worktree-'));
}

function completeArtifact(overrides = {}) {
  return {
    schemaVersion: 1,
    producer: TEST_RESULT_PRODUCER,
    provenance: TEST_RESULT_PROVENANCE,
    scope: 'full',
    status: 'complete',
    command: 'npm test',
    recordedAt: '2026-08-29T00:00:00.000Z',
    testedHead: '0123456789abcdef0123456789abcdef01234567',
    tests: 3,
    pass: 2,
    fail: 1,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    ...overrides,
  };
}

test('parseTapSummary: Node TAP summary の全件数を抽出する', () => {
  assert.deepEqual(parseTapSummary(`
# tests 8
# pass 6
# fail 1
# cancelled 0
# skipped 1
# todo 0
`), {
    ok: true,
    summary: { tests: 8, pass: 6, fail: 1, cancelled: 0, skipped: 1, todo: 0 },
  });
});

test('parseTapSummary: 任意の末尾項目が無くても既定値を補う', () => {
  assert.deepEqual(parseTapSummary('# tests 2\n# pass 2\n# fail 0\n'), {
    ok: true,
    summary: { tests: 2, pass: 2, fail: 0, cancelled: 0, skipped: 0, todo: 0 },
  });
});

test('parseTapSummary: 必須項目欠落・重複・空出力を拒否する', () => {
  assert.equal(parseTapSummary('').ok, false);
  assert.equal(parseTapSummary('# tests 2\n# pass 2\n').ok, false);
  assert.equal(parseTapSummary('# tests 2\n# pass 2\n# fail 0\n# fail 0\n').ok, false);
});

test('validateTestResultArtifact: runnerが作成した complete 成果物を受理する', () => {
  const artifact = completeArtifact();
  assert.deepEqual(validateTestResultArtifact(artifact), { ok: true, value: artifact });
});

test('validateTestResultArtifact: producer/provenance/scope/count の不正を拒否する', () => {
  for (const change of [
    { producer: 'manual' },
    { provenance: 'manual' },
    { scope: 'unknown' },
    { fail: -1 },
    { tests: 1, pass: 2 },
  ]) {
    assert.equal(validateTestResultArtifact({ ...completeArtifact(), ...change }).ok, false);
  }
});

test('write/readTestResultArtifact: runtime rootへ原子的に保存し、worktree外から読み戻す', () => {
  const worktree = tempWorktree();
  const artifact = completeArtifact({ scope: 'partial', pass: 3, fail: 0, tests: 3 });
  const resultPath = writeTestResultArtifact(worktree, artifact);
  const resolvedWorktree = path.resolve(worktree);

  assert.equal(resultPath, testResultPath(worktree));
  assert.equal(path.dirname(resultPath), workspaceRuntimeDir(worktree));
  assert.ok(path.relative(resolvedWorktree, resultPath).startsWith('..'), '成果物はworktree外に置く');
  assert.ok(path.relative(runtimeRoot(), resultPath) !== resultPath);
  assert.deepEqual(readTestResultArtifact(worktree), {
    ok: true,
    path: resultPath,
    result: {
      provenance: 'test-runner',
      scope: 'partial',
      tests: 3,
      pass: 3,
      fail: 0,
      cancelled: 0,
      skipped: 0,
      todo: 0,
      command: 'npm test',
      recordedAt: '2026-08-29T00:00:00.000Z',
      testedHead: '0123456789abcdef0123456789abcdef01234567',
    },
  });
});

test('readTestResultArtifact: 欠落・JSON破損・スキーマ不正をすべて unknown 用に返す', () => {
  const missingWorktree = tempWorktree();
  assert.equal(readTestResultArtifact(missingWorktree).ok, false);
  assert.equal(readTestResultArtifact(missingWorktree).kind, 'missing');

  const corruptWorktree = tempWorktree();
  const corruptPath = testResultPath(corruptWorktree);
  fs.mkdirSync(path.dirname(corruptPath), { recursive: true });
  fs.writeFileSync(corruptPath, '{not-json', 'utf8');
  assert.equal(readTestResultArtifact(corruptWorktree).kind, 'invalid');

  const invalidWorktree = tempWorktree();
  const invalidPath = testResultPath(invalidWorktree);
  fs.mkdirSync(path.dirname(invalidPath), { recursive: true });
  fs.writeFileSync(invalidPath, JSON.stringify(completeArtifact({ producer: 'manual' })), 'utf8');
  assert.equal(readTestResultArtifact(invalidWorktree).kind, 'invalid');
});

test('readTestResultArtifact: unavailable 成果物は完全な結果として扱わない', () => {
  const worktree = tempWorktree();
  const unavailable = {
    schemaVersion: 1,
    producer: TEST_RESULT_PRODUCER,
    provenance: TEST_RESULT_PROVENANCE,
    scope: 'full',
    status: 'unavailable',
    command: 'npm test',
    recordedAt: '2026-08-29T00:00:00.000Z',
    reason: 'tap-summary-invalid',
  };
  writeTestResultArtifact(worktree, unavailable);
  const result = readTestResultArtifact(worktree);
  assert.deepEqual(result, {
    ok: false,
    kind: 'unavailable',
    reason: 'tap-summary-invalid',
    path: testResultPath(worktree),
  });
});

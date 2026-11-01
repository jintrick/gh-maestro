'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  TEST_RESULT_PRODUCER,
  TEST_RESULT_PROVENANCE,
  parseTapSummary,
  parseTapFailures,
  parseTapFailureDetails,
  testResultPath,
  testResultInvalidationPath,
  invalidateTestResultArtifact,
  validateTestResultArtifact,
  validateLintResult,
  validateStaticCheckResult,
  writeTestResultArtifact,
  writeTestResultLayer,
  testResultLockPath,
  readTestResultArtifact,
} = require('../scripts/shared/test-result');
const { listRegisteredWorkspaces, runtimeRoot, workspaceRuntimeDir } = require('../scripts/shared/storage-layout');
const { createTempDirScope } = require('../scripts/shared/temp-directory');

const savedRuntimeDir = process.env.GH_MAESTRO_RUNTIME_DIR;
const tempDirScope = createTempDirScope();
const isolatedRuntimeDir = tempDirScope.mkdtemp('gh-maestro-test-result-runtime-');
process.env.GH_MAESTRO_RUNTIME_DIR = isolatedRuntimeDir;

test.after(() => {
  if (savedRuntimeDir === undefined) delete process.env.GH_MAESTRO_RUNTIME_DIR;
  else process.env.GH_MAESTRO_RUNTIME_DIR = savedRuntimeDir;
  tempDirScope.cleanup();
});

function tempWorktree() {
  return tempDirScope.mkdtemp('gh-maestro-test-result-worktree-');
}

test('validateLintResult: findingsはcompleteなlint実行結果として受理し、記録欠落は成果物検証と区別する', () => {
  const lint = {
    status: 'complete',
    outcome: 'findings',
    findingCount: 2,
    command: 'npm run lint',
    recordedAt: '2026-09-18T00:00:00.000Z',
    testedContentHash: 'a'.repeat(64),
  };
  assert.equal(validateLintResult(lint).ok, true);
  assert.equal(validateLintResult({ ...lint, findingCount: -1 }).ok, false);
  assert.equal(validateTestResultArtifact(completeArtifact()).ok, true, 'lintなしの旧形式は妥当な成果物として読み続ける');
});

test('validateStaticCheckResult: 成功・失敗・起動不能・未定義を区別する', () => {
  const base = { command: 'npm run typecheck', recordedAt: '2026-10-08T00:00:00.000Z' };
  assert.equal(validateStaticCheckResult({ ...base, status: 'complete', outcome: 'pass', exitCode: 0, testedContentHash: 'a'.repeat(64) }).ok, true);
  assert.equal(validateStaticCheckResult({ ...base, status: 'complete', outcome: 'fail', exitCode: 2, testedContentHash: 'a'.repeat(64) }).ok, true);
  assert.equal(validateStaticCheckResult({ ...base, status: 'unavailable', reason: 'spawn-failed', exitCode: null }).ok, true);
  assert.equal(validateStaticCheckResult({ ...base, status: 'undefined' }).ok, true);
  assert.equal(validateStaticCheckResult({ ...base, status: 'complete', outcome: 'fail', exitCode: null }).ok, false);
  assert.equal(validateStaticCheckResult({ ...base, status: 'complete', outcome: 'findings', findingCount: 1, exitCode: 1, testedContentHash: 'a'.repeat(64) }).ok, false, 'typecheck は lint 専用の findings outcome を受理しない');
});

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
    testedContentHash: 'a'.repeat(64),
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

test('parseTapFailures: not ok から失敗テスト名を抽出し、suiteやSKIP/TODOを除外するが同名失敗は重複排除せず全て保持する', () => {
  const tapOutput = `
TAP version 13
# Subtest: test alpha
not ok 1 - test alpha
  ---
  duration_ms: 1.2
  type: 'test'
  ...
# Subtest: test beta
ok 2 - test beta
  ---
  duration_ms: 0.5
  type: 'test'
  ...
# Subtest: suite gamma
    # Subtest: subtest delta
    not ok 1 - subtest delta
      ---
      duration_ms: 0.8
      type: 'test'
      ...
    1..1
not ok 3 - suite gamma
  ---
  duration_ms: 2.1
  type: 'suite'
  failureType: 'subtestsFailed'
  ...
not ok 4 - skipped test # SKIP
not ok 5 - todo test # TODO
not ok 6 - test alpha
`;
  const failures = parseTapFailures(tapOutput);
  assert.equal(failures.length, 3);
  assert.deepEqual(failures, ['test alpha', 'subtest delta', 'test alpha']);
});

test('parseTapFailures: 空出力や失敗なしは空配列を返す', () => {
  assert.deepEqual(parseTapFailures(''), []);
  assert.deepEqual(parseTapFailures('ok 1 - test a\nok 2 - test b\n'), []);
});

test('validateTestResultArtifact: runnerが作成した complete 成果物を受理する', () => {
  const artifact = completeArtifact();
  assert.deepEqual(validateTestResultArtifact(artifact), { ok: true, value: artifact });

  const outcomeOnly = completeArtifact({ outcome: 'fail' });
  for (const field of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    delete outcomeOnly[field];
  }
  assert.deepEqual(validateTestResultArtifact(outcomeOnly), { ok: true, value: outcomeOnly });
});

test('validateTestResultArtifact: producer/provenance/scope/count の不正を拒否する', () => {
  for (const change of [
    { producer: 'manual' },
    { provenance: 'manual' },
    { scope: 'unknown' },
    { fail: -1 },
    { tests: 1, pass: 2 },
    { outcome: 'unknown' },
    { testedContentHash: 'not-a-content-hash' },
  ]) {
    assert.equal(validateTestResultArtifact({ ...completeArtifact(), ...change }).ok, false);
  }
});

test('validateTestResultArtifact: dynamicConcurrencyは完全な入力と下限フォールバックを区別する', () => {
  const complete = {
    value: 5,
    cpuCount: 12,
    reviewJobCount: 3,
    status: 'complete',
    unavailableInputs: [],
  };
  const fallback = {
    value: 1,
    cpuCount: 12,
    reviewJobCount: null,
    status: 'unavailable',
    unavailableInputs: ['reviewJobCount'],
  };
  assert.equal(validateTestResultArtifact(completeArtifact({ dynamicConcurrency: complete })).ok, true);
  assert.equal(validateTestResultArtifact(completeArtifact({ dynamicConcurrency: fallback })).ok, true);
  for (const invalid of [
    { ...complete, value: 0 },
    { ...complete, cpuCount: null },
    { ...complete, unavailableInputs: ['reviewJobCount'] },
    { ...fallback, unavailableInputs: [] },
    { ...fallback, unavailableInputs: ['cpuCount'] },
    { ...fallback, unavailableInputs: ['reviewJobCount', 'reviewJobCount'] },
  ]) {
    assert.equal(validateTestResultArtifact(completeArtifact({ dynamicConcurrency: invalid })).ok, false);
  }
});

test('writeTestResultLayer/readTestResultArtifact: slow層のdynamicConcurrencyを保存・返却する', () => {
  const worktree = tempWorktree();
  const dynamicConcurrency = {
    value: 1,
    cpuCount: 12,
    reviewJobCount: null,
    status: 'unavailable',
    unavailableInputs: ['reviewJobCount'],
  };
  writeTestResultLayer(worktree, {
    layer: 'slow',
    scope: 'partial',
    status: 'complete',
    outcome: 'pass',
    command: 'npm run test:slow',
    recordedAt: '2026-10-16T00:00:00.000Z',
    testedContentHash: 'a'.repeat(64),
    dynamicConcurrency,
  });

  const read = readTestResultArtifact(worktree);
  assert.equal(read.ok, true);
  assert.deepEqual(read.result.layers.slow.dynamicConcurrency, dynamicConcurrency);
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
  assert.deepEqual(listRegisteredWorkspaces(), [], 'テスト結果の保存だけではworkspace registryへ登録しない');
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
      testedContentHash: 'a'.repeat(64),
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

  const outcomeWorktree = tempWorktree();
  const outcomeOnly = completeArtifact({ outcome: 'pass' });
  for (const field of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    delete outcomeOnly[field];
  }
  const outcomePath = writeTestResultArtifact(outcomeWorktree, outcomeOnly);
  assert.deepEqual(readTestResultArtifact(outcomeWorktree), {
    ok: true,
    path: outcomePath,
    result: {
      provenance: 'test-runner',
      scope: 'full',
      outcome: 'pass',
      command: 'npm test',
      recordedAt: '2026-08-29T00:00:00.000Z',
      testedHead: '0123456789abcdef0123456789abcdef01234567',
      testedContentHash: 'a'.repeat(64),
    },
  });

  const invalidatedWorktree = tempWorktree();
  writeTestResultArtifact(invalidatedWorktree, completeArtifact({ outcome: 'pass' }));
  invalidateTestResultArtifact(invalidatedWorktree, 'artifact-write-failed');
  assert.deepEqual(readTestResultArtifact(invalidatedWorktree), {
    ok: false,
    kind: 'unavailable',
    reason: 'artifact-write-failed',
    path: testResultPath(invalidatedWorktree),
  });
  writeTestResultArtifact(invalidatedWorktree, completeArtifact({ outcome: 'pass' }));
  assert.equal(fs.existsSync(testResultInvalidationPath(invalidatedWorktree)), false);
  assert.equal(readTestResultArtifact(invalidatedWorktree).ok, true);
});

test('writeTestResultLayer: 内容指紋が一致すればtestedHeadが異なっても層別保存し、指紋不一致の既存層は破棄する', () => {
  const worktree = tempWorktree();
  const headA = '0123456789abcdef0123456789abcdef01234567';
  const headB = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';
  const hashA = 'a'.repeat(64);
  const hashB = 'b'.repeat(64);
  const layer = (name, testedHead = headA, testedContentHash = hashA) => ({
    layer: name,
    scope: name === 'full' ? 'full' : 'partial',
    status: 'complete',
    outcome: 'pass',
    command: name === 'full' ? 'npm test' : 'npm run test:slow',
    recordedAt: '2026-08-29T00:00:00.000Z',
    executor: name === 'slow' ? 'poll-pr' : 'local',
    testedHead,
    testedContentHash,
    tests: 1,
    pass: 1,
    fail: 0,
  });

  // full をコミット前（親コミット headA）で実行し、slow を PR の HEAD（headB）で実行した場合でも、
  // 内容指紋 hashA が一致していれば両層が保持される
  writeTestResultLayer(worktree, layer('full', headA, hashA));
  writeTestResultLayer(worktree, layer('slow', headB, hashA));
  const aggregate = readTestResultArtifact(worktree);
  assert.equal(aggregate.ok, true);
  assert.deepEqual(Object.keys(aggregate.result.layers).sort(), ['full', 'slow']);

  // 内容指紋が異なる層が書き込まれた場合は、指紋不一致の既存層が破棄される
  writeTestResultLayer(worktree, layer('slow', headB, hashB));
  const replaced = readTestResultArtifact(worktree);
  assert.equal(replaced.ok, true);
  assert.deepEqual(Object.keys(replaced.result.layers), ['slow']);
});

test('writeTestResultLayer: incoming が unavailable（testedContentHash なし）のとき既存層が保持される', () => {
  const worktree = tempWorktree();
  const headA = '0123456789abcdef0123456789abcdef01234567';
  const headB = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';
  const hashA = 'a'.repeat(64);

  // full 層（complete、testedContentHash あり）
  writeTestResultLayer(worktree, {
    layer: 'full',
    scope: 'full',
    status: 'complete',
    outcome: 'pass',
    command: 'npm test',
    recordedAt: '2026-08-29T00:00:00.000Z',
    testedHead: headA,
    testedContentHash: hashA,
    tests: 1,
    pass: 1,
    fail: 0,
  });

  // poll-pr.js の unavailableSlowLayer に相当する層（testedContentHash なし）
  writeTestResultLayer(worktree, {
    layer: 'slow',
    scope: 'partial',
    status: 'unavailable',
    command: 'npm run test:slow',
    recordedAt: '2026-08-29T00:01:00.000Z',
    testedHead: headB,
    executor: 'poll-pr',
    executionLogPath: '/tmp/slow.log',
    reason: 'runner-abnormal-exit',
  });

  const aggregate = readTestResultArtifact(worktree);
  assert.equal(aggregate.ok, true);
  assert.deepEqual(Object.keys(aggregate.result.layers).sort(), ['full', 'slow']);
  assert.equal(aggregate.result.layers.full.status, 'complete');
  assert.equal(aggregate.result.layers.slow.status, 'unavailable');
});

test('writeTestResultLayer: 既存層に testedContentHash がない場合も incoming 層追加で破棄されない', () => {
  const worktree = tempWorktree();
  const headA = '0123456789abcdef0123456789abcdef01234567';
  const headB = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';
  const hashB = 'b'.repeat(64);

  // 既存層が unavailable（testedContentHash なし）
  writeTestResultLayer(worktree, {
    layer: 'slow',
    scope: 'partial',
    status: 'unavailable',
    command: 'npm run test:slow',
    recordedAt: '2026-08-29T00:00:00.000Z',
    testedHead: headA,
    executor: 'poll-pr',
    reason: 'slow-result-missing',
  });

  // incoming 層（complete、testedContentHash あり）
  writeTestResultLayer(worktree, {
    layer: 'full',
    scope: 'full',
    status: 'complete',
    outcome: 'pass',
    command: 'npm test',
    recordedAt: '2026-08-29T00:01:00.000Z',
    testedHead: headB,
    testedContentHash: hashB,
    tests: 2,
    pass: 2,
    fail: 0,
  });

  const aggregate = readTestResultArtifact(worktree);
  assert.equal(aggregate.ok, true);
  assert.deepEqual(Object.keys(aggregate.result.layers).sort(), ['full', 'slow']);
  assert.equal(aggregate.result.layers.slow.status, 'unavailable');
  assert.equal(aggregate.result.layers.full.status, 'complete');
});

test('writeTestResultLayer: 集約ロック取得失敗は既存成果物を変更しない', () => {
  const worktree = tempWorktree();
  const lockPath = testResultLockPath(worktree);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, 'locked', 'utf8');
  assert.throws(() => writeTestResultLayer(worktree, {
    layer: 'full',
    scope: 'full',
    status: 'complete',
    outcome: 'pass',
    command: 'npm test',
    recordedAt: '2026-08-29T00:00:00.000Z',
    testedHead: '0123456789abcdef0123456789abcdef01234567',
    testedContentHash: 'a'.repeat(64),
  }), /lock is unavailable/);
});

test('writeTestResultLayer: typecheck記録をlint互換フィールドと共通checksへ同時保存する', () => {
  const worktree = tempWorktree();
  const hash = 'a'.repeat(64);
  const lint = {
    status: 'complete', outcome: 'pass', findingCount: 0,
    command: 'npm run lint', recordedAt: '2026-10-08T00:00:00.000Z', testedContentHash: hash,
  };
  const typecheck = {
    status: 'complete', outcome: 'fail', exitCode: 2,
    command: 'npm run typecheck', recordedAt: '2026-10-08T00:00:00.000Z', testedContentHash: hash,
  };
  writeTestResultLayer(worktree, {
    layer: 'full', scope: 'full', status: 'complete', outcome: 'pass',
    command: 'npm test', recordedAt: '2026-10-08T00:00:00.000Z',
    testedHead: '0123456789abcdef0123456789abcdef01234567', testedContentHash: hash,
  }, { lint, typecheck });
  const result = readTestResultArtifact(worktree);
  assert.equal(result.ok, true);
  assert.deepEqual(result.result.lint, lint);
  assert.deepEqual(result.result.checks.typecheck, typecheck);
  assert.deepEqual(result.result.typecheck, typecheck);
});

test('writeTestResultLayer: 指紋なし unavailable 層の追加後も lint と typecheck の記録を保持する', () => {
  const worktree = tempWorktree();
  const hash = 'a'.repeat(64);
  const lint = {
    status: 'complete', outcome: 'pass', findingCount: 0,
    command: 'npm run lint', recordedAt: '2026-10-08T00:00:00.000Z', testedContentHash: hash,
  };
  const typecheck = {
    status: 'complete', outcome: 'pass', exitCode: 0,
    command: 'npm run typecheck', recordedAt: '2026-10-08T00:00:00.000Z', testedContentHash: hash,
  };
  writeTestResultLayer(worktree, {
    layer: 'full', scope: 'full', status: 'complete', outcome: 'pass',
    command: 'npm test', recordedAt: '2026-10-08T00:00:00.000Z',
    testedHead: '0123456789abcdef0123456789abcdef01234567', testedContentHash: hash,
  }, { lint, typecheck });
  writeTestResultLayer(worktree, {
    layer: 'slow', scope: 'partial', status: 'unavailable',
    command: 'npm run test:slow', recordedAt: '2026-10-08T00:01:00.000Z',
    testedHead: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
    executor: 'poll-pr', reason: 'slow-result-missing',
  });

  const result = readTestResultArtifact(worktree);
  assert.equal(result.ok, true);
  assert.deepEqual(result.result.lint, lint);
  assert.deepEqual(result.result.checks.typecheck, typecheck);
  assert.deepEqual(result.result.typecheck, typecheck);
});

// 実機の node:test（v22.15.0, --test-reporter=tap）の出力を、パスだけ差し替えて固定したもの。
// 期待値はこの文字列を読んで手で書いた値であり、実装の出力から導いていない。
const REAL_NODE_TAP_FAILURES = `TAP version 13
# Subtest: alpha fails
not ok 1 - alpha fails
  ---
  duration_ms: 1.5998
  type: 'test'
  location: '/work/fixtures/f.test.js:3:1'
  failureType: 'testCodeFailure'
  error: |-
    sum mismatch

    2 !== 3

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 3
  actual: 2
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (/work/fixtures/f.test.js:3:36)
    Test.runInAsyncScope (node:async_hooks:214:14)
  ...
# Subtest: beta fails
not ok 2 - beta fails
  ---
  duration_ms: 1.8834
  type: 'test'
  location: '/work/fixtures/f.test.js:4:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly deep-equal:
    + actual - expected

      {
    +   a: 1
    -   a: 2
      }

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected:
    a: 2
  actual:
    a: 1
  operator: 'deepStrictEqual'
  stack: |-
    TestContext.<anonymous> (/work/fixtures/f.test.js:4:35)
  ...
# Subtest: gamma ok
ok 3 - gamma ok
  ---
  duration_ms: 0.1692
  type: 'test'
  ...
1..3
# tests 3
# pass 1
# fail 2
`;

test('parseTapFailureDetails: 実機のnode:test出力から、場所・エラー・期待値・実際値を失敗ごとに取り出す（stackは載せない）', () => {
  const details = parseTapFailureDetails(REAL_NODE_TAP_FAILURES);
  assert.equal(details.length, 2);
  assert.equal(details[0].name, 'alpha fails');
  assert.equal(details[0].location, '/work/fixtures/f.test.js:3:1');
  assert.equal(details[0].error, 'sum mismatch ⏎ 2 !== 3');
  assert.equal(details[0].expected, '3');
  assert.equal(details[0].actual, '2');
  assert.equal(details[1].name, 'beta fails');
  assert.equal(details[1].location, '/work/fixtures/f.test.js:4:1');
  assert.ok(details[1].error.startsWith('Expected values to be strictly deep-equal:'));
  assert.equal(details[1].expected, 'a: 2', '複数行のexpectedを連結して読む');
  assert.equal(details[1].actual, 'a: 1');
  assert.doesNotMatch(JSON.stringify(details), /TestContext|runInAsyncScope/, 'stackの行を中身として読まない');
  assert.deepEqual(parseTapFailures(REAL_NODE_TAP_FAILURES), ['alpha fails', 'beta fails'], '名前だけの従来挙動は変わらない');
});

test('parseTapFailureDetails: 長い値は項目ごとの上限で切り詰める（error は300字）', () => {
  const longError = 'x'.repeat(400);
  const output = `TAP version 13
not ok 1 - long one
  ---
  error: '${longError}'
  ...
1..1
`;
  const [detail] = parseTapFailureDetails(output);
  assert.equal(detail.error.length, 300);
  assert.ok(detail.error.endsWith('…'));
});

test('parseTapFailureDetails: 診断ブロックが無い失敗は名前だけを返す', () => {
  assert.deepEqual(parseTapFailureDetails('not ok 1 - bare\n'), [{ name: 'bare' }]);
});

test('validateTestResultArtifact: failureDetails の型不正を種別ごとに独立して拒否する', () => {
  const good = { name: 'a', location: '/x.js:1:1', error: 'e', expected: '1', actual: '2' };
  assert.equal(validateTestResultArtifact(completeArtifact({ failureDetails: [good] })).ok, true);
  for (const invalid of [
    'not-an-array',
    ['plain string'],
    [{ location: '/x.js:1:1' }],
    [{ name: '' }],
    [{ name: 'a', error: 42 }],
    [{ name: 'a', expected: null }],
    [null],
    Array.from({ length: 6 }, (_, i) => ({ name: `t${i}` })),
  ]) {
    assert.equal(validateTestResultArtifact(completeArtifact({ failureDetails: invalid })).ok, false, JSON.stringify(invalid).slice(0, 80));
  }
});

test('writeTestResultLayer/readTestResultArtifact: slow層のfailureDetailsを保存し、読み取り結果にも返す', () => {
  const worktree = tempWorktree();
  const failureDetails = [{ name: 'slow case', location: '/x.js:2:1', error: 'boom', expected: '1', actual: '0' }];
  writeTestResultLayer(worktree, {
    layer: 'slow',
    scope: 'partial',
    status: 'complete',
    outcome: 'fail',
    fail: 1,
    pass: 0,
    tests: 1,
    command: 'npm run test:slow',
    recordedAt: '2026-10-16T00:00:00.000Z',
    testedContentHash: 'a'.repeat(64),
    failedTests: ['slow case'],
    failureDetails,
  });
  const read = readTestResultArtifact(worktree);
  assert.equal(read.ok, true);
  assert.deepEqual(read.result.layers.slow.failureDetails, failureDetails);
});

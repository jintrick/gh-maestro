'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  TEST_RESULT_MARKER,
  USAGE,
  buildCommentBody,
  declareTestResult,
  main,
} = require('../scripts/declare-test-result');

const MARKER = TEST_RESULT_MARKER;
const SHA = 'a1b2c3d4e5f67890123456789012345678901234';
const CONTENT_HASH = 'a'.repeat(64);
const RESULT = {
  provenance: 'test-runner',
  scope: 'full',
  tests: 1826,
  pass: 1826,
  fail: 0,
  testedContentHash: CONTENT_HASH,
};

function githubResult(htmlUrl) {
  return { status: 0, stdout: JSON.stringify({ html_url: htmlUrl }), stderr: '' };
}

function baseDeps(overrides = {}) {
  return {
    gitHeadFn: () => SHA,
    readTestResultFn: () => ({ ok: true, result: RESULT }),
    ghListCommentsFn: () => ({ status: 0, stdout: '[]', stderr: '' }),
    ghCreateCommentFn: () => githubResult('https://github.com/owner/repo/pull/42#issuecomment-1'),
    ghUpdateCommentFn: () => githubResult('https://github.com/owner/repo/pull/42#issuecomment-1'),
    commitContentHashFn: () => CONTENT_HASH,
    ...overrides,
  };
}

test('buildCommentBody: ランナー由来の full 結果だけを値付きで出力する', () => {
  const body = buildCommentBody({ commit: SHA, testResult: RESULT });
  assert.ok(body.includes(MARKER));
  assert.ok(body.includes(`- **対象コミット**: \`${SHA}\``));
  assert.ok(body.includes('- **結果**: pass (fail: 0, pass: 1826)'));
  assert.ok(body.includes('- **実行件数**: `1826`'));
  assert.ok(body.includes('- **実行元**: `test-runner`'));
  assert.ok(body.includes('- **実行範囲**: `full`'));
});

test('buildCommentBody: typecheck失敗をlint行を保って申告する', () => {
  const body = buildCommentBody({
    commit: SHA,
    testResult: {
      provenance: 'test-runner', scope: 'aggregate', outcome: 'pass',
      layers: { full: { status: 'complete', outcome: 'pass', scope: 'full', command: 'npm test' } },
      lint: { status: 'complete', outcome: 'pass', findingCount: 0 },
      typecheck: { status: 'complete', outcome: 'fail', exitCode: 2 },
    },
  });
  assert.match(body, /- \*\*lint\*\*: pass \(findings: 0\)/);
  assert.match(body, /- \*\*typecheck\*\*: fail \(exit code: 2\)/);
});

test('declareTestResult: typecheck失敗は記録して申告し、必須記録の存在だけを検証する', () => {
  const testResult = {
    provenance: 'test-runner', scope: 'aggregate',
    layers: { full: { layer: 'full', scope: 'full', status: 'complete', outcome: 'pass', testedContentHash: CONTENT_HASH } },
    lint: { status: 'complete', outcome: 'pass', findingCount: 0, command: 'npm run lint', recordedAt: 'now', testedContentHash: CONTENT_HASH },
    typecheck: { status: 'complete', outcome: 'fail', exitCode: 2, command: 'npm run typecheck', recordedAt: 'now', testedContentHash: CONTENT_HASH },
  };
  const result = declareTestResult(
    { pr: '42', repo: 'owner/repo', headSha: SHA, requiredLayers: ['full'], requireTypecheckResult: true },
    baseDeps({ readTestResultFn: () => ({ ok: true, result: testResult }) }),
  );
  assert.equal(result.ok, true);
});

test('buildCommentBody: fail > 0 は runner の値から fail として出力する', () => {
  const body = buildCommentBody({
    commit: SHA,
    testResult: { ...RESULT, pass: 100, fail: 3, tests: 103, scope: 'partial' },
  });
  assert.ok(body.includes('- **結果**: fail (fail: 3, pass: 100)'));
  assert.ok(body.includes('- **実行範囲**: `partial`'));
});

test('buildCommentBody: 件数が無くてもrunnerのoutcomeをknownとして出力する', () => {
  const body = buildCommentBody({
    commit: SHA,
    testResult: {
      provenance: 'test-runner',
      scope: 'partial',
      outcome: 'fail',
      testedContentHash: CONTENT_HASH,
    },
  });
  assert.ok(body.includes('- **結果**: fail'));
  assert.doesNotMatch(body, /fail: \d/);
  assert.ok(body.includes('- **実行元**: `test-runner`'));
  assert.ok(body.includes('- **実行範囲**: `partial`'));
});

test('buildCommentBody: 成果物が無い場合は unknown と実行記録不在を出力する', () => {
  const body = buildCommentBody({
    commit: SHA,
    testResult: { provenance: 'unknown', scope: 'unknown', reason: 'invalid-json' },
  });
  assert.ok(body.includes('- **結果**: unknown'));
  assert.ok(body.includes('- **実行元**: `unknown`'));
  assert.ok(body.includes('- **実行範囲**: `unknown`'));
  assert.ok(body.includes('- **実行記録**: unavailable (unavailable)'));
  assert.doesNotMatch(body, /fail: \d/);
});

test('buildCommentBody: 層別aggregateはfull/slowの結果とslowの実行記録を同時に出力する', () => {
  const body = buildCommentBody({
    commit: SHA,
    testResult: {
      provenance: 'test-runner',
      scope: 'aggregate',
      layers: {
        full: {
          status: 'complete', outcome: 'pass', tests: 10, pass: 10, fail: 0,
          executor: 'test-runner', scope: 'full',
        },
        slow: {
          status: 'complete', outcome: 'fail', tests: 2, pass: 1, fail: 1,
          executor: 'poll-pr', scope: 'partial',
          executionLogPath: 'C:/runtime/slow.log',
          dynamicConcurrency: {
            value: 1,
            cpuCount: null,
            reviewJobCount: 2,
            status: 'unavailable',
            unavailableInputs: ['cpuCount'],
          },
        },
      },
    },
  });
  assert.ok(body.includes('- **実行範囲**: `aggregate`'));
  assert.ok(body.includes('**full**: pass'));
  assert.ok(body.includes('**slow**: fail'));
  assert.ok(body.includes('executor: `test-runner`, scope: `full`'));
  assert.ok(body.includes('executor: `poll-pr`, scope: `partial`'));
  assert.ok(body.includes('実行記録: `slow.log`'));
  assert.ok(body.includes('並列数: 1, CPU数: unknown, Review Managerジョブ数: 2, 並列数状態: unavailable, 並列数取得失敗: cpuCount'));
  assert.ok(!body.includes('C:/runtime/'), '公開先のコメントにローカルの絶対パスを載せない');
  assert.ok(body.includes('- **結果**: fail'));
});

test('buildCommentBody: 失敗テスト名が5件以内なら全件表示し、5件を超える分は「他N件」と表示する（pass層には表示しない）', () => {
  const body = buildCommentBody({
    commit: SHA,
    testResult: {
      provenance: 'test-runner',
      scope: 'aggregate',
      layers: {
        full: {
          status: 'complete', outcome: 'fail', tests: 17, pass: 10, fail: 7,
          executor: 'local', scope: 'full',
          failedTests: ['test 1', 'test 2', 'test 3', 'test 4', 'test 5', 'test 6', 'test 7'],
        },
        slow: {
          status: 'complete', outcome: 'fail', tests: 2, pass: 1, fail: 1,
          executor: 'poll-pr', scope: 'partial',
          failedTests: ['slow failure alpha'],
        },
      },
    },
  });
  // full層: 7件中5件表示 + 他2件
  assert.ok(body.includes('**full**: fail (fail: 7, pass: 10), tests: 17, executor: `local`, scope: `full`, 失敗: `test 1`, `test 2`, `test 3`, `test 4`, `test 5`（他2件）'));
  // slow層: 1件のみ表示
  assert.ok(body.includes('**slow**: fail (fail: 1, pass: 1), tests: 2, executor: `poll-pr`, scope: `partial`, 失敗: `slow failure alpha`'));
  assert.doesNotMatch(body, /slow failure alpha.*他/);
});

test('buildCommentBody: 同名テストの失敗が複数ある場合も重複排除せず、実失敗数に基づいて5件表示および「他N件」を計算する', () => {
  const body = buildCommentBody({
    commit: SHA,
    testResult: {
      provenance: 'test-runner',
      scope: 'aggregate',
      layers: {
        full: {
          status: 'complete', outcome: 'fail', tests: 7, pass: 0, fail: 7,
          executor: 'local', scope: 'full',
          failedTests: ['same error', 'same error', 'unique error', 'same error', 'same error', 'same error', 'same error'],
        },
      },
    },
  });
  // 7件の失敗中5件表示（同名が4件＋uniqueが1件）＋他2件
  assert.ok(body.includes('**full**: fail (fail: 7, pass: 0), tests: 7, executor: `local`, scope: `full`, 失敗: `same error`, `same error`, `unique error`, `same error`, `same error`（他2件）'));
});

test('buildCommentBody: 失敗が0件の層では失敗テスト名を表示しない', () => {
  const body = buildCommentBody({
    commit: SHA,
    testResult: {
      provenance: 'test-runner',
      scope: 'aggregate',
      layers: {
        full: {
          status: 'complete', outcome: 'pass', tests: 10, pass: 10, fail: 0,
          executor: 'local', scope: 'full',
          failedTests: [],
        },
      },
    },
  });
  assert.ok(body.includes('**full**: pass (fail: 0, pass: 10)'));
  assert.doesNotMatch(body, /失敗:/);
});

test('buildCommentBody: unavailable層はcommandと具体的なreasonをunknownとして申告する', () => {
  const body = buildCommentBody({
    commit: SHA,
    testResult: {
      provenance: 'test-runner',
      scope: 'aggregate',
      layers: {
        full: {
          status: 'complete', outcome: 'pass', tests: 10, pass: 10, fail: 0,
          executor: 'test-runner', scope: 'full',
        },
        slow: {
          status: 'unavailable',
          command: 'npm run test:slow',
          reason: "runner-abnormal-exit: command: npm run test:slow; stderr: Cannot find module './tests/_env-setup.js'; GH_TOKEN=should-not-appear",
          executor: 'poll-pr',
          scope: 'partial',
          executionLogPath: 'C:/runtime/slow.log',
        },
      },
    },
  });

  assert.ok(body.includes('**slow**: unknown'));
  assert.ok(body.includes('command: `npm run test:slow`'));
  assert.ok(body.includes('reason: module-not-found'));
  assert.doesNotMatch(body, /Cannot find module|_env-setup|GH_TOKEN|should-not-appear/);
  assert.ok(body.includes('- **結果**: unknown'));
  assert.doesNotMatch(body, /\*\*slow\*\*: fail/);
});

test('declareTestResult: 手入力の commit/fail/pass を API 境界で拒否する', () => {
  let externalCall = false;
  const deps = baseDeps({ ghListCommentsFn: () => { externalCall = true; return { status: 0, stdout: '[]' }; } });
  for (const obsolete of ['commit', 'fail', 'pass']) {
    const result = declareTestResult({ pr: '42', repo: 'owner/repo', headSha: SHA, [obsolete]: 0 }, deps);
    assert.equal(result.ok, false);
    assert.match(result.error, new RegExp(obsolete));
  }
  assert.equal(externalCall, false);
});

test('declareTestResult: PR番号不正を外部アクセス前に拒否する', () => {
  let externalCall = false;
  const deps = baseDeps({ ghListCommentsFn: () => { externalCall = true; return { status: 0, stdout: '[]' }; } });
  for (const pr of ['', '-1', 'abc', '042']) {
    const result = declareTestResult({ pr, repo: 'owner/repo', headSha: SHA }, deps);
    assert.equal(result.ok, false);
    assert.match(result.error, /--pr/);
  }
  assert.equal(externalCall, false);
});

test('declareTestResult: HEAD解決失敗・不正値を申告前に拒否する', () => {
  const failed = declareTestResult(
    { pr: '42', repo: 'owner/repo' },
    baseDeps({ gitHeadFn: () => { throw new Error('not a worktree'); } }),
  );
  assert.equal(failed.ok, false);
  assert.match(failed.error, /HEAD解決に失敗/);

  const invalid = declareTestResult(
    { pr: '42', repo: 'owner/repo' },
    baseDeps({ gitHeadFn: () => 'not-a-sha' }),
  );
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /HEAD解決結果が不正/);
});

test('declareTestResult: 既存コメントなし → runner の証跡を新規投稿する', () => {
  let createdBody = null;
  const result = declareTestResult(
    { pr: '42', repo: 'owner/repo', headSha: SHA, worktree: '/worktree' },
    baseDeps({
      ghListCommentsFn: (pr, repo) => {
        assert.equal(pr, '42');
        assert.equal(repo, 'owner/repo');
        return { status: 0, stdout: '[]', stderr: '' };
      },
      ghCreateCommentFn: (pr, repo, body) => {
        assert.equal(pr, '42');
        assert.equal(repo, 'owner/repo');
        createdBody = body;
        return githubResult('https://github.com/owner/repo/pull/42#issuecomment-1001');
      },
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.action, 'created');
  assert.equal(result.provenance, 'test-runner');
  assert.equal(result.scope, 'full');
  assert.equal(result.url, 'https://github.com/owner/repo/pull/42#issuecomment-1001');
  assert.match(createdBody, /gh-maestro-test-result:v2/);
  assert.match(createdBody, /fail: 0, pass: 1826/);
  assert.match(createdBody, /実行範囲.*full/);
});

test('declareTestResult: 件数なしのoutcomeでもknown結果を新規投稿する', () => {
  let createdBody = null;
  const result = declareTestResult(
    { pr: '42', repo: 'owner/repo', headSha: SHA, worktree: '/worktree' },
    baseDeps({
      readTestResultFn: () => ({ ok: true, result: {
        provenance: 'test-runner',
        scope: 'full',
        outcome: 'pass',
        testedContentHash: CONTENT_HASH,
      } }),
      ghCreateCommentFn: (_pr, _repo, body) => {
        createdBody = body;
        return githubResult('https://github.com/owner/repo/pull/42#issuecomment-1007');
      },
    }),
  );

  assert.equal(result.ok, true);
  assert.match(createdBody, /結果.*pass/);
  assert.doesNotMatch(createdBody, /fail: \d/);
});

test('declareTestResult: 既存の v1/v2 コメントは最新のものを PATCH 更新する', () => {
  let updatedCommentId = null;
  let updatedBody = null;
  const comments = [
    {
      id: 1001,
      body: '<!-- gh-maestro-test-result:v1 -->\n- **対象コミット**: `0000000`\n- **結果**: fail (fail: 1)',
      html_url: 'https://github.com/owner/repo/pull/42#issuecomment-1001',
    },
    { id: 1002, body: 'ordinary comment', html_url: 'https://example.test/1002' },
    {
      id: 1003,
      body: '<!-- gh-maestro-test-result:v2 -->\n- **対象コミット**: `1111111`\n- **結果**: unknown',
      html_url: 'https://github.com/owner/repo/pull/42#issuecomment-1003',
    },
  ];

  const result = declareTestResult(
    { pr: '42', repo: 'owner/repo', headSha: SHA },
    baseDeps({
      ghListCommentsFn: () => ({ status: 0, stdout: JSON.stringify(comments), stderr: '' }),
      ghUpdateCommentFn: (commentId, repo, body) => {
        updatedCommentId = commentId;
        updatedBody = body;
        return githubResult('https://github.com/owner/repo/pull/42#issuecomment-1003');
      },
      ghCreateCommentFn: () => { throw new Error('新規投稿してはいけない'); },
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.action, 'updated');
  assert.equal(updatedCommentId, 1003);
  assert.match(updatedBody, new RegExp(SHA));
  assert.match(updatedBody, /結果.*pass.*fail: 0, pass: 1826/);
});

test('declareTestResult: 成果物の欠落・破損でも unknown を投稿し、申告を止めない', () => {
  let createdBody = null;
  const result = declareTestResult(
    { pr: '42', repo: 'owner/repo', headSha: SHA },
    baseDeps({
      readTestResultFn: () => ({ ok: false, kind: 'invalid', reason: 'invalid-json' }),
      ghCreateCommentFn: (_pr, _repo, body) => {
        createdBody = body;
        return githubResult('https://github.com/owner/repo/pull/42#issuecomment-1004');
      },
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.provenance, 'unknown');
  assert.equal(result.scope, 'unknown');
  assert.match(createdBody, /結果.*unknown/);
  assert.match(createdBody, /実行記録.*unavailable/);
  assert.doesNotMatch(createdBody, /fail: \d/);
});

test('declareTestResult: 必須層指定時は成果物の欠落を申告前に拒否する', () => {
  let listed = false;
  const result = declareTestResult(
    { pr: '42', repo: 'owner/repo', headSha: SHA, requiredLayers: ['full'] },
    baseDeps({
      readTestResultFn: () => ({ ok: false, kind: 'missing', reason: 'missing' }),
      ghListCommentsFn: () => { listed = true; return { status: 0, stdout: '[]' }; },
    }),
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /必須テスト層の結果が揃っていません.*full/);
  assert.equal(listed, false, '不足した成果物ではGitHubコメントを取得しない');
});

test('declareTestResult: lint記録のない旧形式成果物は古いものとして再実行を促す', () => {
  const result = declareTestResult(
    { pr: '42', repo: 'owner/repo', headSha: SHA, requireLintResult: true },
    baseDeps({
      readTestResultFn: () => ({ ok: true, result: {
        provenance: 'test-runner',
        scope: 'aggregate',
        layers: {
          full: {
            layer: 'full', scope: 'full', status: 'complete', outcome: 'pass',
            testedContentHash: CONTENT_HASH,
          },
        },
      } }),
    }),
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /古い/);
  assert.match(result.error, /run-tests\.js を再実行/);
  assert.match(result.error, /lint-result-missing/);
});

test('declareTestResult: typecheck記録のない旧形式成果物は再実行を促す', () => {
  const result = declareTestResult(
    { pr: '42', repo: 'owner/repo', headSha: SHA, requiredLayers: ['full'], requireTypecheckResult: true },
    baseDeps({ readTestResultFn: () => ({ ok: true, result: {
      provenance: 'test-runner', scope: 'aggregate',
      layers: { full: { layer: 'full', scope: 'full', status: 'complete', outcome: 'pass', testedContentHash: CONTENT_HASH } },
      lint: { status: 'complete', outcome: 'pass', findingCount: 0, testedContentHash: CONTENT_HASH },
    } }) }),
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /typecheck-result-missing/);
  assert.match(result.error, /run-tests\.js を再実行/);
});

test('declareTestResult: JSON破損と型不正は旧形式とは別の失敗種別で拒否する', () => {
  const invalidJson = declareTestResult(
    { pr: '42', repo: 'owner/repo', headSha: SHA, requireLintResult: true },
    baseDeps({ readTestResultFn: () => ({ ok: false, kind: 'invalid', reason: 'invalid-json' }) }),
  );
  const invalidShape = declareTestResult(
    { pr: '42', repo: 'owner/repo', headSha: SHA, requireLintResult: true },
    baseDeps({ readTestResultFn: () => ({ ok: false, kind: 'invalid', reason: 'invalid-artifact' }) }),
  );

  assert.equal(invalidJson.ok, false);
  assert.match(invalidJson.error, /JSONが壊れています/);
  assert.match(invalidJson.error, /invalid-json/);
  assert.equal(invalidShape.ok, false);
  assert.match(invalidShape.error, /型または構造が不正/);
  assert.match(invalidShape.error, /invalid-artifact/);
  assert.notEqual(invalidJson.error, invalidShape.error);
});

test('declareTestResult: 未実行許容時も欠落だけを許容し、内容不一致は拒否する', () => {
  const missing = declareTestResult(
    {
      pr: '42', repo: 'owner/repo', headSha: SHA,
      requiredLayers: ['full'], allowMissingRequiredLayers: true,
    },
    baseDeps({ readTestResultFn: () => ({ ok: false, kind: 'missing', reason: 'missing' }) }),
  );
  assert.equal(missing.ok, true);
  assert.equal(missing.scope, 'unknown');

  const mismatched = declareTestResult(
    {
      pr: '42', repo: 'owner/repo', headSha: SHA,
      requiredLayers: ['full'], allowMissingRequiredLayers: true,
    },
    baseDeps({ commitContentHashFn: () => 'b'.repeat(64) }),
  );
  assert.equal(mismatched.ok, false);
  assert.match(mismatched.error, /必須テスト層の結果が揃っていません.*full/);
});

test('declareTestResult: 必須層指定時は既存の内容照合でunavailableになった結果を拒否する', () => {
  const result = declareTestResult(
    { pr: '42', repo: 'owner/repo', headSha: SHA, requiredLayers: ['full'] },
    baseDeps({
      readTestResultFn: () => ({ ok: true, result: {
        provenance: 'test-runner',
        scope: 'aggregate',
        layers: {
          full: {
            layer: 'full', scope: 'full', status: 'complete', outcome: 'pass',
            testedContentHash: CONTENT_HASH,
          },
        },
      } }),
      commitContentHashFn: () => 'b'.repeat(64),
    }),
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /必須テスト層の結果が揃っていません.*full/);
});

test('declareTestResult: aggregateはテスト時のHEADが異なっても内容指紋一致で受理する', () => {
  let createdBody = null;
  const result = declareTestResult(
    { pr: '42', repo: 'owner/repo', headSha: SHA, requiredLayers: ['full'] },
    baseDeps({
      readTestResultFn: () => ({ ok: true, result: {
        provenance: 'test-runner',
        scope: 'aggregate',
        testedHead: 'b'.repeat(40),
        layers: {
          full: {
            layer: 'full', scope: 'full', status: 'complete', outcome: 'pass',
            testedHead: 'b'.repeat(40), testedContentHash: CONTENT_HASH,
          },
        },
      } }),
      ghCreateCommentFn: (_pr, _repo, body) => {
        createdBody = body;
        return githubResult('https://github.com/owner/repo/pull/42#issuecomment-1008');
      },
    }),
  );

  assert.equal(result.ok, true);
  assert.match(createdBody, /\*\*full\*\*: pass/);
});

test('declareTestResult: 必須aggregate層の欠落を拒否し、completeなfailは受理する', () => {
  const incomplete = declareTestResult(
    { pr: '42', repo: 'owner/repo', headSha: SHA, requiredLayers: ['full'] },
    baseDeps({
      readTestResultFn: () => ({ ok: true, result: {
        provenance: 'test-runner',
        scope: 'aggregate',
        layers: {
          slow: {
            layer: 'slow', scope: 'partial', status: 'complete', outcome: 'pass',
            testedContentHash: CONTENT_HASH,
          },
        },
      } }),
    }),
  );
  assert.equal(incomplete.ok, false);
  assert.match(incomplete.error, /必須テスト層の結果が揃っていません.*full/);

  const completeFail = declareTestResult(
    { pr: '42', repo: 'owner/repo', headSha: SHA, requiredLayers: ['full'] },
    baseDeps({
      readTestResultFn: () => ({ ok: true, result: {
        provenance: 'test-runner',
        scope: 'aggregate',
        layers: {
          full: {
            layer: 'full', scope: 'full', status: 'complete', outcome: 'fail',
            testedContentHash: CONTENT_HASH,
          },
        },
      } }),
    }),
  );
  assert.equal(completeFail.ok, true);
});

test('declareTestResult: テスト対象の内容と申告先コミットが不一致ならunknownで継続する', () => {
  let createdBody = null;
  const result = declareTestResult(
    { pr: '42', repo: 'owner/repo', headSha: SHA },
    baseDeps({
      commitContentHashFn: () => 'b'.repeat(64),
      ghCreateCommentFn: (_pr, _repo, body) => {
        createdBody = body;
        return githubResult('https://github.com/owner/repo/pull/42#issuecomment-1005');
      },
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.provenance, 'unknown');
  assert.equal(result.scope, 'unknown');
  assert.match(createdBody, /結果.*unknown/);
  assert.match(createdBody, /content-mismatch/);
  assert.doesNotMatch(createdBody, /fail: \d/);
});

test('declareTestResult: テスト時のHEADが違っていても内容指紋が一致すればfullを維持する', () => {
  let createdBody = null;
  const result = declareTestResult(
    { pr: '42', repo: 'owner/repo', headSha: SHA },
    baseDeps({
      readTestResultFn: () => ({ ok: true, result: { ...RESULT, testedHead: 'b'.repeat(40) } }),
      ghCreateCommentFn: (_pr, _repo, body) => {
        createdBody = body;
        return githubResult('https://github.com/owner/repo/pull/42#issuecomment-1006');
      },
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.provenance, 'test-runner');
  assert.equal(result.scope, 'full');
  assert.match(createdBody, /fail: 0, pass: 1826/);
});

test('declareTestResult: GitHub の既存コメント取得失敗は申告失敗として返す', () => {
  const result = declareTestResult(
    { pr: '42', repo: 'owner/repo', headSha: SHA },
    baseDeps({ ghListCommentsFn: () => ({ status: 1, stdout: '', stderr: 'network unavailable' }) }),
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /network unavailable/);
});

test('main: --help は終了コード0で usage を返し、旧数値引数は拒否する', () => {
  const help = main(['--help']);
  assert.equal(help.exitCode, 0);
  assert.equal(help.stdout, USAGE);

  const obsolete = main(['--pr', '42', '--fail', '0']);
  assert.equal(obsolete.exitCode, 1);
  assert.match(obsolete.stderr, /未知のフラグ/);
});

test('main: --pr 欠落時は終了コード1', () => {
  const result = main(['--repo', 'owner/repo']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /必須/);
});

// CLIの実行例が実際にusageを出すことだけを、非再帰の境界テストとして確認する。

function slowFailureBody(failureDetails, extra = {}) {
  return buildCommentBody({
    commit: SHA,
    testResult: {
      provenance: 'test-runner',
      scope: 'aggregate',
      layers: {
        full: { status: 'complete', outcome: 'pass', tests: 2, pass: 2, fail: 0, executor: 'local', scope: 'full' },
        slow: {
          status: 'complete', outcome: 'fail', tests: 2, pass: 1, fail: 1,
          executor: 'poll-pr', scope: 'partial',
          failedTests: failureDetails.map(d => d.name),
          failureDetails,
          ...extra,
        },
      },
    },
  });
}

test('buildCommentBody: slow層の失敗は名前・場所・エラー・期待値・実際値をネスト行に載せる', () => {
  const body = slowFailureBody([{ name: 'slow case', location: '/x.test.js:3:1', error: 'sum mismatch ⏎ 2 !== 3', expected: '3', actual: '2' }]);
  assert.ok(body.includes('    - 失敗詳細: `slow case` / 場所: `x.test.js:3:1` / エラー: `sum mismatch ⏎ 2 !== 3` / 期待値: `3` / 実際値: `2`'));
});

test('buildCommentBody: ネスト行は層行として読まれない形で出す（層名・pass/fail を偽装した本文でも層行にならない）', () => {
  const body = slowFailureBody([{ name: 'fake', error: '**full**: pass (fail: 0, pass: 9) / fail: 0' }]);
  const lines = body.split('\n').filter(line => /^\s{2,}-\s+\*\*[^*]+\*\*:\s*(pass|fail|unknown)\b/i.test(line));
  assert.equal(lines.length, 2, 'full と slow の層行だけ');
});

test('buildCommentBody: 詳細は合計2000字で打ち切り、残りは件数と実行記録の名前で示す', () => {
  const big = Array.from({ length: 5 }, (_, i) => ({ name: `case ${i}`, error: 'e'.repeat(450) }));
  const body = slowFailureBody(big, { executionLogPath: 'C:/runtime/slow-pr-42-abc.log' });
  const detailLines = body.split('\n').filter(line => line.startsWith('    - 失敗詳細:'));
  const total = detailLines.reduce((sum, line) => sum + line.length, 0);
  assert.ok(total <= 2000, `詳細の合計は2000字以内（実際: ${total}）`);
  assert.ok(detailLines.length < 5, '全件は載らない');
  assert.ok(body.includes('（残り'), '省略した件数を示す');
  assert.ok(body.includes('`slow-pr-42-abc.log`'), '実行記録のファイル名を示す');
  assert.ok(!body.includes('C:/runtime/'), '絶対パスは載せない');
});

test('buildCommentBody: 失敗の中身の文字列にバッククォートがあっても、コードスパンを壊さない', () => {
  const body = slowFailureBody([{ name: 'with `tick`', expected: 'a`b' }]);
  assert.ok(body.includes("失敗詳細: `with 'tick'`"));
  assert.ok(body.includes("期待値: `a'b`"));
});

test('buildCommentBody: 失敗の中身がない層（pass・中身の無い失敗）の出力は、中身の項目を含めても変わらない', () => {
  const passBody = buildCommentBody({
    commit: SHA,
    testResult: {
      provenance: 'test-runner', scope: 'aggregate',
      layers: {
        full: { status: 'complete', outcome: 'pass', tests: 2, pass: 2, fail: 0, executor: 'local', scope: 'full', failureDetails: [{ name: 'ignored' }] },
        slow: { status: 'complete', outcome: 'pass', tests: 1, pass: 1, fail: 0, executor: 'poll-pr', scope: 'partial' },
      },
    },
  });
  assert.ok(!passBody.includes('失敗詳細'), 'pass 層には中身を出さない');
  const withoutDetails = slowFailureBody([]);
  assert.ok(!withoutDetails.includes('失敗詳細'));
});

function slowResultWithDetails(failureDetails, extra = {}) {
  return {
    provenance: 'test-runner',
    scope: 'aggregate',
    layers: {
      slow: {
        status: 'complete', outcome: 'fail', tests: failureDetails.length, pass: 0, fail: failureDetails.length,
        executor: 'poll-pr', scope: 'partial',
        failedTests: failureDetails.map(detail => detail.name),
        failureDetails,
        ...extra,
      },
    },
  };
}

test('buildCommentBody: 件数の上限で省いた分も「残り N件」に含める（failedTests が failureDetails より多い）', () => {
  const failureDetails = Array.from({ length: 5 }, (_, i) => ({ name: `case ${i}`, error: 'e' }));
  const failedTests = Array.from({ length: 7 }, (_, i) => `case ${i}`);
  const testResult = slowResultWithDetails(failureDetails, { failedTests, fail: 7, tests: 7 });
  const body = buildCommentBody({ commit: SHA, testResult });
  assert.ok(body.includes('    - （残り2件の詳細は省略）'), body);
});

test('buildCommentBody: 場所は worktree からの相対パスで出し、区切り文字が混在しても絶対パスを載せない', () => {
  const worktree = 'C:/work/wt';
  const body = buildCommentBody({
    commit: SHA,
    worktree,
    testResult: slowResultWithDetails([{
      name: 'a',
      location: 'C:\\\\work\\\\wt\\\\tests\\\\a.test.js:3:1',
      error: 'failed at C:/work/wt/tests/a.test.js',
    }]),
  });
  assert.ok(body.includes('場所: `tests/a.test.js:3:1`'), body);
  assert.ok(body.includes('エラー: `failed at <worktree>/tests/a.test.js`'), body);
  assert.doesNotMatch(body, /C:[\\/]+work/);
});

test('buildCommentBody: worktree の外の場所はファイル名だけにする', () => {
  const body = buildCommentBody({
    commit: SHA,
    worktree: 'C:/work/wt',
    testResult: slowResultWithDetails([{ name: 'b', location: 'D:\\\\other\\\\x.test.js:9:1' }]),
  });
  assert.ok(body.includes('場所: `x.test.js:9:1`'), body);
  assert.doesNotMatch(body, /D:[\\/]+other/);
});

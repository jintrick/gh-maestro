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
  assert.ok(!body.includes('C:/runtime/'), '公開先のコメントにローカルの絶対パスを載せない');
  assert.ok(body.includes('- **結果**: fail'));
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

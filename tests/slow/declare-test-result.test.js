'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  TEST_RESULT_MARKER,
  USAGE,
  buildCommentBody,
  declareTestResult,
  main,
} = require('../../scripts/declare-test-result');

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

test('buildCommentBody: 成果物が無い場合は unknown と実行記録不在を出力する', () => {
  const body = buildCommentBody({
    commit: SHA,
    testResult: { provenance: 'unknown', scope: 'unknown', reason: 'invalid-json' },
  });
  assert.ok(body.includes('- **結果**: unknown'));
  assert.ok(body.includes('- **実行元**: `unknown`'));
  assert.ok(body.includes('- **実行範囲**: `unknown`'));
  assert.ok(body.includes('- **実行記録**: unavailable (invalid-json)'));
  assert.doesNotMatch(body, /fail: \d/);
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
  assert.match(createdBody, /実行記録.*invalid-json/);
  assert.doesNotMatch(createdBody, /fail: \d/);
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
test('declare-test-result.js: サブプロセス経由 --help で終了コード0', () => {
  const { spawnSync } = require('child_process');
  const path = require('path');
  const script = path.join(__dirname, '..', '..', 'scripts', 'declare-test-result.js');
  const result = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes(USAGE));
});

test('declare-test-result.js: サブプロセス経由の引数不足は終了コード1', () => {
  const { spawnSync } = require('child_process');
  const path = require('path');
  const script = path.join(__dirname, '..', '..', 'scripts', 'declare-test-result.js');
  const result = spawnSync(process.execPath, [script, '--repo', 'owner/repo'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /必須/);
});

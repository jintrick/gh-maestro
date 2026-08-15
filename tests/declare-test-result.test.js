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

// ── buildCommentBody ────────────────────────────────────────────────────────

test('buildCommentBody: fail 0 の場合は pass 表記になる', () => {
  const body = buildCommentBody({ commit: 'a1b2c3d', failCount: 0, passCount: 1826 });
  assert.ok(body.includes(MARKER));
  assert.ok(body.includes('- **対象コミット**: `a1b2c3d`'));
  assert.ok(body.includes('- **結果**: pass (fail: 0, pass: 1826)'));
});

test('buildCommentBody: fail > 0 の場合は fail 表記になる', () => {
  const body = buildCommentBody({ commit: 'a1b2c3d', failCount: 3, passCount: 100 });
  assert.ok(body.includes(MARKER));
  assert.ok(body.includes('- **対象コミット**: `a1b2c3d`'));
  assert.ok(body.includes('- **結果**: fail (fail: 3, pass: 100)'));
});

test('buildCommentBody: passCount 未指定時は fail のみ出力', () => {
  const body = buildCommentBody({ commit: 'a1b2c3d', failCount: 0 });
  assert.ok(body.includes('- **結果**: pass (fail: 0)'));
});

// ── declareTestResult バリデーション ────────────────────────────────────────

test('declareTestResult: --commit が欠落または無効な場合はエラーで拒否する（HEAD暗黙補完禁止）', () => {
  const r1 = declareTestResult({ pr: '10', commit: '', fail: 0 });
  assert.equal(r1.ok, false);
  assert.match(r1.error, /--commit/);

  const r2 = declareTestResult({ pr: '10', commit: 'invalid-sha', fail: 0 });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /--commit/);

  const r3 = declareTestResult({ pr: '10', commit: '12345', fail: 0 }); // 7文字未満
  assert.equal(r3.ok, false);
  assert.match(r3.error, /--commit/);
});

test('declareTestResult: --pr が欠落または無効な場合はエラーで拒否する', () => {
  const r1 = declareTestResult({ pr: '', commit: 'a1b2c3d', fail: 0 });
  assert.equal(r1.ok, false);
  assert.match(r1.error, /--pr/);

  const r2 = declareTestResult({ pr: '-1', commit: 'a1b2c3d', fail: 0 });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /--pr/);

  const r3 = declareTestResult({ pr: 'abc', commit: 'a1b2c3d', fail: 0 });
  assert.equal(r3.ok, false);
  assert.match(r3.error, /--pr/);
});

test('declareTestResult: --fail が欠落または無効な場合はエラーで拒否する', () => {
  const r1 = declareTestResult({ pr: '10', commit: 'a1b2c3d', fail: -1 });
  assert.equal(r1.ok, false);
  assert.match(r1.error, /--fail/);

  const r2 = declareTestResult({ pr: '10', commit: 'a1b2c3d', fail: 'abc' });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /--fail/);
});

test('declareTestResult: --pass が負数や非整数の場合はエラーで拒否する', () => {
  const r1 = declareTestResult({ pr: '10', commit: 'a1b2c3d', fail: 0, pass: -5 });
  assert.equal(r1.ok, false);
  assert.match(r1.error, /--pass/);

  const r2 = declareTestResult({ pr: '10', commit: 'a1b2c3d', fail: 0, pass: 'xyz' });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /--pass/);
});

// ── declareTestResult 投稿・更新動作 ────────────────────────────────────────

test('declareTestResult: 既存の申告コメントなし → 新規投稿（POST）する', () => {
  let createdBody = null;
  const result = declareTestResult(
    { pr: '42', commit: 'a1b2c3d4e5', fail: 0, pass: 100, repo: 'owner/repo' },
    {
      ghRepoViewFn: () => ({ status: 0, stdout: 'owner/repo\n', stderr: '' }),
      ghListCommentsFn: (pr, repo) => {
        assert.equal(pr, '42');
        assert.equal(repo, 'owner/repo');
        return { status: 0, stdout: '[]', stderr: '' };
      },
      ghCreateCommentFn: (pr, repo, body) => {
        assert.equal(pr, '42');
        assert.equal(repo, 'owner/repo');
        createdBody = body;
        return {
          status: 0,
          stdout: JSON.stringify({ id: 1001, html_url: 'https://github.com/owner/repo/pull/42#issuecomment-1001' }),
          stderr: '',
        };
      },
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.action, 'created');
  assert.equal(result.url, 'https://github.com/owner/repo/pull/42#issuecomment-1001');
  assert.ok(createdBody.includes(MARKER));
  assert.ok(createdBody.includes('a1b2c3d4e5'));
});

test('declareTestResult: 既存の申告コメントあり → PATCH 更新する（新規投稿は増やさない）', () => {
  let updatedCommentId = null;
  let updatedBody = null;
  const existing = {
    id: 9999,
    body: `${MARKER}\n### 🧪 テスト結果申告\n- **対象コミット**: \`0000000\`\n- **結果**: fail (fail: 1)`,
    html_url: 'https://github.com/owner/repo/pull/42#issuecomment-9999',
  };

  const result = declareTestResult(
    { pr: '42', commit: 'f1e2d3c4b5', fail: 0, pass: 50, repo: 'owner/repo' },
    {
      ghRepoViewFn: () => ({ status: 0, stdout: 'owner/repo\n', stderr: '' }),
      ghListCommentsFn: () => ({ status: 0, stdout: JSON.stringify([existing]), stderr: '' }),
      ghUpdateCommentFn: (commentId, repo, body) => {
        updatedCommentId = commentId;
        updatedBody = body;
        return {
          status: 0,
          stdout: JSON.stringify({ id: 9999, html_url: 'https://github.com/owner/repo/pull/42#issuecomment-9999' }),
          stderr: '',
        };
      },
      ghCreateCommentFn: () => {
        throw new Error('createComment should not be called');
      },
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.action, 'updated');
  assert.equal(result.url, 'https://github.com/owner/repo/pull/42#issuecomment-9999');
  assert.equal(updatedCommentId, 9999);
  assert.ok(updatedBody.includes('f1e2d3c4b5'));
  assert.ok(updatedBody.includes('pass (fail: 0, pass: 50)'));
});

test('declareTestResult: 複数の申告コメントが存在する場合、最新（末尾）のコメントを PATCH 更新する', () => {
  let updatedCommentId = null;
  const oldDecl = {
    id: 1001,
    body: `${MARKER}\n### 🧪 テスト結果申告\n- **対象コミット**: \`1111111\`\n- **結果**: fail (fail: 1)`,
    html_url: 'https://github.com/owner/repo/pull/42#issuecomment-1001',
  };
  const newDecl = {
    id: 1002,
    body: `${MARKER}\n### 🧪 テスト結果申告\n- **対象コミット**: \`2222222\`\n- **結果**: pass (fail: 0)`,
    html_url: 'https://github.com/owner/repo/pull/42#issuecomment-1002',
  };

  const result = declareTestResult(
    { pr: '42', commit: '3333333333', fail: 0, pass: 10, repo: 'owner/repo' },
    {
      ghRepoViewFn: () => ({ status: 0, stdout: 'owner/repo\n', stderr: '' }),
      ghListCommentsFn: () => ({ status: 0, stdout: JSON.stringify([oldDecl, { id: 1005, body: 'other' }, newDecl]), stderr: '' }),
      ghUpdateCommentFn: (commentId, repo, body) => {
        updatedCommentId = commentId;
        return {
          status: 0,
          stdout: JSON.stringify({ id: commentId, html_url: `https://github.com/owner/repo/pull/42#issuecomment-${commentId}` }),
          stderr: '',
        };
      },
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.action, 'updated');
  assert.equal(updatedCommentId, 1002);
});

// ── CLI main() ─────────────────────────────────────────────────────────────

test('main: --help は終了コード0で usage を返す', () => {
  const r = main(['--help']);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, USAGE);
});

test('main: 必須フラグ欠落時は終了コード1', () => {
  const r = main(['--pr', '42']);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /必須/);
});

// ── サブプロセス起動テスト ──────────────────────────────────────────────────

test('declare-test-result.js: サブプロセス経由 --help で終了コード0', () => {
  const { spawnSync } = require('child_process');
  const path = require('path');
  const script = path.join(__dirname, '..', 'scripts', 'declare-test-result.js');
  const r = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes(USAGE));
});

test('declare-test-result.js: サブプロセス経由 引数不足で終了コード1', () => {
  const { spawnSync } = require('child_process');
  const path = require('path');
  const script = path.join(__dirname, '..', 'scripts', 'declare-test-result.js');
  const r = spawnSync(process.execPath, [script, '--pr', '10'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /必須/);
});

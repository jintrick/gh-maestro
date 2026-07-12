'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

// poll-pr.js は require.main===module 時のみCLIを実行するため、
// resolveReviewAspects/getChangedFiles/spawnPollReviews は純粋関数としてrequireで検証する。
// spawnPollReviews は child-process.js の spawnSync をモックし、実プロセスを0個spawnする
// （.claude/rules/test-process-spawn-safety.md 準拠）。CLI起動時の即時エラー終了パス
// （--review-aspects省略・未知キーワード）のみ、ループに入らず即exitすることを利用して
// 実プロセスをspawnSyncで同期実行する（detachedポーラーは起動しない）。

const pollPrPath = require.resolve('../scripts/poll-pr');

/**
 * scripts/child-process.js の spawnSync をモックした状態で poll-pr.js を再ロードする。
 * @param {Function} spawnSyncImpl (cmd, args, opts) => result
 */
function loadModule(spawnSyncImpl) {
  const calls = [];
  const fakeSpawnSync = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return spawnSyncImpl ? spawnSyncImpl(cmd, args, opts) : { status: 0, stdout: '' };
  };

  const childProcessPath = require.resolve('../scripts/child-process');
  delete require.cache[childProcessPath];
  require.cache[childProcessPath] = {
    id: childProcessPath,
    filename: childProcessPath,
    loaded: true,
    exports: { spawn: () => { throw new Error('spawn should not be called in this test'); }, spawnSync: fakeSpawnSync, execSync: () => '' },
  };

  delete require.cache[pollPrPath];
  const mod = require(pollPrPath);

  delete require.cache[childProcessPath];
  return { mod, calls };
}

// ── resolveReviewAspects ─────────────────────────────────────────────────

test('resolveReviewAspects accepts "auto"', () => {
  const { mod } = loadModule();
  assert.deepEqual(mod.resolveReviewAspects('auto', ['api-contract']), { mode: 'auto' });
});

test('resolveReviewAspects accepts a comma-separated list of known leaves', () => {
  const { mod } = loadModule();
  const result = mod.resolveReviewAspects('api-contract,concurrency', ['api-contract', 'concurrency', 'test-quality']);
  assert.deepEqual(result, { mode: 'explicit', aspects: ['api-contract', 'concurrency'] });
});

test('resolveReviewAspects rejects an unknown leaf name', () => {
  const { mod } = loadModule();
  assert.throws(
    () => mod.resolveReviewAspects('api-contract,typo-aspect', ['api-contract', 'concurrency']),
    /未知の観点キーワードです.*typo-aspect/
  );
});

test('resolveReviewAspects rejects an empty element', () => {
  const { mod } = loadModule();
  assert.throws(() => mod.resolveReviewAspects('api-contract,,concurrency', ['api-contract', 'concurrency']));
});

// ── getChangedFiles ──────────────────────────────────────────────────────

test('getChangedFiles parses newline-separated file paths from gh output', () => {
  const { mod, calls } = loadModule(() => ({ status: 0, stdout: 'a.js\nb.js\n' }));
  const files = mod.getChangedFiles('7', 'o/r');
  assert.deepEqual(files, ['a.js', 'b.js']);
  assert.equal(calls[0].cmd, 'gh');
  assert.ok(calls[0].args.includes('7'));
});

test('getChangedFiles returns an empty array for empty gh output', () => {
  const { mod } = loadModule(() => ({ status: 0, stdout: '' }));
  assert.deepEqual(mod.getChangedFiles('7', 'o/r'), []);
});

test('getChangedFiles warns and returns an empty array when gh pr view fails', () => {
  const { mod } = loadModule(() => ({ status: 1, stdout: '', stderr: 'rate limit exceeded' }));
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const files = mod.getChangedFiles('7', 'o/r');
    assert.deepEqual(files, []);
    assert.ok(errors.some(e => e.includes('変更ファイル一覧の取得に失敗しました')));
    assert.ok(errors.some(e => e.includes('rate limit exceeded')));
  } finally {
    console.error = originalError;
  }
});

// ── spawnPollReviews ─────────────────────────────────────────────────────

test('spawnPollReviews launches poll-reviews.js as a child with inherited stdio', () => {
  const { mod, calls } = loadModule(() => ({ status: 0 }));
  const code = mod.spawnPollReviews('12', '/workspace', 4321);
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.cmd, process.execPath);
  assert.ok(call.args.some(a => a.endsWith('poll-reviews.js')));
  assert.ok(call.args.includes('12'));
  assert.ok(call.args.includes('/workspace'));
  assert.ok(call.args.includes('--session-pid'));
  assert.ok(call.args.includes('4321'));
  assert.equal(call.opts.stdio, 'inherit');
});

test('spawnPollReviews returns 1 when poll-reviews.js exits without a status', () => {
  const { mod } = loadModule(() => ({ status: null }));
  assert.equal(mod.spawnPollReviews('12', '/workspace', 4321), 1);
});

test('spawnPollReviews propagates a non-zero exit code', () => {
  const { mod } = loadModule(() => ({ status: 3 }));
  assert.equal(mod.spawnPollReviews('12', '/workspace', 4321), 3);
});


// ── getPrBaseBranch ───────────────────────────────────────────────────────

test("getPrBaseBranch parses baseRefName from gh pr view output", () => {
  const { mod, calls } = loadModule(() => ({ status: 0, stdout: "dev\n" }));
  const branch = mod.getPrBaseBranch("42", "o/r");
  assert.equal(branch, "dev");
  assert.equal(calls[0].cmd, "gh");
  assert.ok(calls[0].args.includes("42"));
  assert.ok(calls[0].args.includes("baseRefName"));
});

test("getPrBaseBranch returns empty string when gh pr view fails", () => {
  const { mod } = loadModule(() => ({ status: 1, stderr: "not found" }));
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const branch = mod.getPrBaseBranch("999", "o/r");
    assert.equal(branch, "");
    assert.ok(errors.some(e => e.includes("ベースブランチ取得に失敗しました")));
  } finally {
    console.error = originalError;
  }
});

test("getPrBaseBranch returns empty string for empty gh output", () => {
  const { mod } = loadModule(() => ({ status: 0, stdout: "" }));
  assert.equal(mod.getPrBaseBranch("42", "o/r"), "");
});

// ── formatBaseBranchMismatch ──────────────────────────────────────────────

test("formatBaseBranchMismatch returns null when branches match", () => {
  const { mod } = loadModule();
  const result = mod.formatBaseBranchMismatch("dev", "dev", "42");
  assert.equal(result, null);
});

test("formatBaseBranchMismatch returns mismatch line when branches differ", () => {
  const { mod } = loadModule();
  const result = mod.formatBaseBranchMismatch("dev", "main", "42");
  assert.equal(result, "PR_BASE_MISMATCH:42:dev:main");
});

test("formatBaseBranchMismatch returns null when expected is empty", () => {
  const { mod } = loadModule();
  assert.equal(mod.formatBaseBranchMismatch("", "dev", "42"), null);
});

test("formatBaseBranchMismatch returns null when actual is empty", () => {
  const { mod } = loadModule();
  assert.equal(mod.formatBaseBranchMismatch("dev", "", "42"), null);
});

// ── CLI起動時の即時エラー終了パス（ループに入る前にexitするため実プロセスspawn可） ──

test('CLI exits non-zero when --review-aspects is omitted', () => {
  const result = spawnSync(process.execPath, [pollPrPath, '111'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--review-aspects/);
});

test('CLI exits non-zero for an unknown --review-aspects keyword', () => {
  const result = spawnSync(process.execPath, [pollPrPath, '111', '--review-aspects', 'not-a-real-aspect'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /未知の観点キーワードです/);
  assert.match(result.stderr, /not-a-real-aspect/);
});

test('CLI exits non-zero when --review-aspects value is missing', () => {
  const result = spawnSync(process.execPath, [pollPrPath, '111', '--review-aspects'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
});

test('CLI --help exits 0 without requiring --review-aspects', () => {
  const result = spawnSync(process.execPath, [pollPrPath, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /review-aspects/);
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

// poll-pr.js は require.main===module 時のみCLIを実行するため、
// getPrBaseBranch/formatBaseBranchMismatch/spawnPollReviews は純粋関数としてrequireで検証する。
// spawnPollReviews は child-process.js の spawnSync をモックし、実プロセスを0個spawnする
// CLI起動時の即時エラー終了パス
// （--help）のみ、ループに入らず即exitすることを利用して実プロセスをspawnSyncで同期実行する
// （detachedポーラーは起動しない）。
//
// 観点選定（旧--review-aspects auto/明示リスト）は廃止した。ファイルパターンでの
// 機械的な観点自動判定が一部の観点だけに絞り込んでしまい他の観点のレビューが丸ごと
// 欠落する実障害があったため、poll-pr.jsは常にReview Managerをheavyモード（全観点）で
// 起動するだけにし、観点を絞り込むかどうかの判断はReview Manager自身（実際のdiffを
// 見た上での判断）に委ねる（skills/gh-maestro-reviewer/SKILL.md参照）。

const pollPrPath = require.resolve('../../scripts/poll-pr');

/**
 * scripts/shared/child-process.js の spawnSync をモックした状態で poll-pr.js を再ロードする。
 * @param {Function} spawnSyncImpl (cmd, args, opts) => result
 */
function loadModule(spawnSyncImpl) {
  const calls = [];
  const fakeSpawnSync = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return spawnSyncImpl ? spawnSyncImpl(cmd, args, opts) : { status: 0, stdout: '' };
  };

  const childProcessPath = require.resolve('../../scripts/shared/child-process');
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

// ── getPrState（Issue #289: poll-reviews 終了後の続行判断用） ─────────────

test("getPrState parses state from gh pr view output", () => {
  const { mod, calls } = loadModule(() => ({ status: 0, stdout: "CLOSED\n" }));
  const state = mod.getPrState("42", "o/r");
  assert.equal(state, "CLOSED");
  assert.equal(calls[0].cmd, "gh");
  assert.ok(calls[0].args.includes("42"));
  assert.ok(calls[0].args.includes("state"));
});

test("getPrState returns empty string when gh pr view fails (fail-closed)", () => {
  const { mod } = loadModule(() => ({ status: 1, stderr: "not found" }));
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const state = mod.getPrState("999", "o/r");
    assert.equal(state, "");
    assert.ok(errors.some(e => e.includes("状態取得に失敗しました")));
  } finally {
    console.error = originalError;
  }
});

// ── resolvePostReviewDecision（Issue #289: CLOSED → findPR 復帰） ────────────
const { resolvePostReviewDecision } = require('../../scripts/poll-pr');

test("resolvePostReviewDecision: 子が正常終了かつ CLOSED は findPR へ復帰（resume）", () => {
  // 子（poll-reviews.js）が exit 0 で正常終了し、却下・キャンセルで CLOSED された PR は
  // マージ待ちではないため、新 PR 検出へ戻る
  assert.equal(resolvePostReviewDecision("CLOSED", 0), "resume");
});

test("resolvePostReviewDecision: 子が正常終了でも MERGED 等は exit", () => {
  assert.equal(resolvePostReviewDecision("MERGED", 0), "exit");
  assert.equal(resolvePostReviewDecision("OPEN", 0), "exit");
});

test("resolvePostReviewDecision: 子が非ゼロ終了なら CLOSED でも resume せず exit に倒れる", () => {
  // 子が非ゼロ終了・シグナル終了（SIGKILL等）した場合は、SIGKILLでは子自身の exit 通知が
  // 実行できず監視停止が誰にも届かない。PR が CLOSED でも復帰せず親も exit に倒し、
  // 親の exit 通知（notifyWatchdogExit）で監視停止を待機側へ届ける（受け入れ条件3）。
  assert.equal(resolvePostReviewDecision("CLOSED", 1), "exit");
  assert.equal(resolvePostReviewDecision("CLOSED", 7), "exit");
});

test("resolvePostReviewDecision: 状態取得失敗（空文字列）は fail-closed で exit に倒れる", () => {
  // 状態が取得できないとき resume に倒れると、poll-reviews の異常終了を
  // 勝手に新 PR 監視で隠蔽してしまう。fail-closed で exit に倒し、異常を
  // exit 通知で表面化させる（自己復旧しない = 受け入れ条件4 と整合）。
  assert.equal(resolvePostReviewDecision("", 0), "exit");
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

test("formatBaseBranchMismatch reports (unknown) when actual is empty (fail-closed)", () => {
  const { mod } = loadModule();
  assert.equal(mod.formatBaseBranchMismatch("dev", "", "42"), "PR_BASE_MISMATCH:42:dev:(unknown)");
});

// ── CLI起動時の即時エラー終了パス（ループに入る前にexitするため実プロセスspawn可） ──

test('CLI --help exits 0 and no longer mentions --review-aspects（廃止した観点自動判定フラグの回帰防止）', () => {
  const result = spawnSync(process.execPath, [pollPrPath, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /--review-aspects/);
  // --no-review-manager（レビューを蒸し返さずに監視だけ再開する再起動用フラグ）が文書化されていること
  assert.match(result.stdout, /--no-review-manager/);
});

test('CLI exits non-zero when <ISSUE> is omitted', () => {
  const result = spawnSync(process.execPath, [pollPrPath], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage/);
});

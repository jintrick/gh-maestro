'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  readTestResultArtifact,
  writeTestResultLayer,
} = require('../scripts/shared/test-result');

// poll-pr.js は require.main===module 時のみCLIを実行するため、
// getPrBaseBranch/formatBaseBranchMismatch/spawnPollReviews は純粋関数としてrequireで検証する。
// spawnPollReviews は child-process.js の spawn をモックし、実プロセスを0個spawnする
// CLI起動時の即時エラー終了パス
// （--help）のみ、ループに入らず即exitすることを利用して実プロセスをspawnSyncで同期実行する
// （detachedポーラーは起動しない）。
//
// 観点選定（旧--review-aspects auto/明示リスト）は廃止した。ファイルパターンでの
// 機械的な観点自動判定が一部の観点だけに絞り込んでしまい他の観点のレビューが丸ごと
// 欠落する実障害があったため、poll-pr.jsは常にReview Managerをheavyモード（全観点）で
// 起動するだけにし、観点を絞り込むかどうかの判断はReview Manager自身（実際のdiffを
// 見た上での判断）に委ねる（skills/gh-maestro-reviewer/SKILL.md参照）。

const pollPrPath = require.resolve('../scripts/poll-pr');

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
  const fakeSpawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    const result = spawnSyncImpl ? spawnSyncImpl(cmd, args, opts) : { status: 0 };
    process.nextTick(() => child.emit('close', result && result.status));
    return child;
  };

  const childProcessPath = require.resolve('../scripts/shared/child-process');
  delete require.cache[childProcessPath];
  require.cache[childProcessPath] = {
    id: childProcessPath,
    filename: childProcessPath,
    loaded: true,
    exports: { spawn: fakeSpawn, spawnSync: fakeSpawnSync, execSync: () => '' },
  };

  delete require.cache[pollPrPath];
  const mod = require(pollPrPath);

  delete require.cache[childProcessPath];
  return { mod, calls };
}

// ── spawnPollReviews ─────────────────────────────────────────────────────

test('spawnPollReviews launches poll-reviews.js as an asynchronous child with inherited stdio', async () => {
  const { mod, calls } = loadModule(() => ({ status: 0 }));
  const code = await mod.spawnPollReviews('12', '/workspace', 4321);
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

test('spawnPollReviews returns 1 when poll-reviews.js exits without a status', async () => {
  const { mod } = loadModule(() => ({ status: null }));
  assert.equal(await mod.spawnPollReviews('12', '/workspace', 4321), 1);
});

test('spawnPollReviews propagates a non-zero exit code', async () => {
  const { mod } = loadModule(() => ({ status: 3 }));
  assert.equal(await mod.spawnPollReviews('12', '/workspace', 4321), 3);
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

test('getPrHead rejects an empty or malformed gh response', () => {
  const { mod } = loadModule(() => ({ status: 0, stdout: 'not-a-sha\n' }));
  assert.equal(mod.getPrHead('42', 'o/r'), '');
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
const { resolvePostReviewDecision } = require('../scripts/poll-pr');

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

function temporaryWorkspace(prefix) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
  return workspace;
}

function captureStdout() {
  const chunks = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk, ...args) => {
    chunks.push(String(chunk));
    return true;
  };
  return {
    output: () => chunks.join(''),
    restore: () => { process.stdout.write = originalWrite; },
  };
}

test('recordHeadUnavailable persists a reachable log and state record', () => {
  const { mod } = loadModule();
  const workspace = temporaryWorkspace('gh-maestro-poll-pr-head-unavailable-');
  const previousRuntime = process.env.GH_MAESTRO_RUNTIME_DIR;
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-poll-pr-runtime-'));
  process.env.GH_MAESTRO_RUNTIME_DIR = runtime;
  const output = captureStdout();
  try {
    const result = mod.recordHeadUnavailable({
      pr: '42',
      repo: 'fixture/repo',
      workspace,
      reason: 'pr-head-unavailable',
    });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.artifactPath, result.statePath);
    assert.ok(fs.existsSync(result.artifactPath));
    assert.ok(fs.existsSync(result.executionLogPath));
    assert.match(fs.readFileSync(result.executionLogPath, 'utf8'), /pr-head-unavailable/);

    const state = JSON.parse(fs.readFileSync(result.statePath, 'utf8'));
    assert.equal(state.runs['head-unavailable'].status, 'unavailable');
    assert.equal(state.runs['head-unavailable'].result.executionLogPath, result.executionLogPath);
    const event = JSON.parse(output.output().trim().slice('SLOW_TEST_RESULT:'.length));
    assert.equal(event.artifactPath, result.artifactPath);
    assert.equal(event.executionLogPath, result.executionLogPath);
    assert.equal(event.statePath, result.statePath);
  } finally {
    output.restore();
    if (previousRuntime === undefined) delete process.env.GH_MAESTRO_RUNTIME_DIR;
    else process.env.GH_MAESTRO_RUNTIME_DIR = previousRuntime;
  }
});

test('resolveSlowWorktree resolves the unique senior-coder worktree for an issue', () => {
  const { mod } = loadModule();
  const workspace = temporaryWorkspace('gh-maestro-poll-pr-worktree-');
  const workerName = 'fixture-senior';
  const worktree = path.join(workspace, '.gh-maestro', 'worktrees', workerName);
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(workspace, '.gh-maestro', 'workers.json'), JSON.stringify({
    [workerName]: { issue: 461, skill: 'gh-maestro-senior-coder' },
  }), 'utf8');

  assert.deepEqual(mod.resolveSlowWorktree(workspace, 461), { workerName, worktree });
});

function completeLayer(layer, head) {
  return {
    layer,
    scope: layer === 'full' ? 'full' : 'partial',
    status: 'complete',
    outcome: 'pass',
    command: layer === 'full' ? 'npm test' : 'npm run test:slow',
    recordedAt: '2026-09-06T00:00:00.000Z',
    executor: layer === 'full' ? 'local' : 'poll-pr',
    testedHead: head,
    testedContentHash: 'a'.repeat(64),
    tests: 1,
    pass: 1,
    fail: 0,
  };
}

test('runSlowTest starts the child, preserves the full layer, and declares the aggregate', async () => {
  const { mod } = loadModule();
  const workspace = temporaryWorkspace('gh-maestro-poll-pr-run-slow-');
  const worktree = path.join(workspace, '.gh-maestro', 'worktrees', 'fixture-senior');
  fs.mkdirSync(worktree, { recursive: true });
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-poll-pr-runtime-'));
  const previousRuntime = process.env.GH_MAESTRO_RUNTIME_DIR;
  process.env.GH_MAESTRO_RUNTIME_DIR = runtime;
  const head = '0123456789abcdef0123456789abcdef01234567';
  const child = new EventEmitter();
  child.pid = 1234;
  const declareCalls = [];
  let spawnOptions;
  try {
    writeTestResultLayer(worktree, completeLayer('full', head));
    const result = await mod.runSlowTest({
      pr: '42', issue: 461, repo: 'fixture/repo', workspace, headSha: head,
    }, {
      resolveSlowWorktreeFn: () => ({ workerName: 'fixture-senior', worktree }),
      resolveGitHeadFn: () => head,
      spawnFn: (_command, _args, options) => {
        spawnOptions = options;
        return child;
      },
      waitChildExitFn: async ({ onCleanup }) => {
        writeTestResultLayer(worktree, {
          ...completeLayer('slow', head),
          executionLogPath: spawnOptions.env.GH_MAESTRO_TEST_LOG_PATH,
        });
        onCleanup();
        return 0;
      },
      declareTestResultFn: (args) => {
        declareCalls.push(args);
        return { ok: true };
      },
    });

    assert.equal(result.status, 'pass');
    assert.equal(result.testedHead, head);
    assert.equal(declareCalls.length, 1);
    assert.equal(declareCalls[0].headSha, head);
    assert.equal(spawnOptions.env.GH_MAESTRO_TEST_ACTOR, 'poll-pr');
    assert.equal(spawnOptions.env.GH_MAESTRO_TEST_LOG_PATH, result.executionLogPath);
    assert.ok(fs.existsSync(result.artifactPath));
    assert.equal(readTestResultArtifact(worktree).result.layers.full.outcome, 'pass');
    assert.equal(readTestResultArtifact(worktree).result.layers.slow.outcome, 'pass');
  } finally {
    if (previousRuntime === undefined) delete process.env.GH_MAESTRO_RUNTIME_DIR;
    else process.env.GH_MAESTRO_RUNTIME_DIR = previousRuntime;
  }
});

test('runSlowTest records a worktree resolution failure before a child or log handle exists', async () => {
  const { mod } = loadModule();
  const workspace = temporaryWorkspace('gh-maestro-poll-pr-resolve-failure-');
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-poll-pr-runtime-'));
  const previousRuntime = process.env.GH_MAESTRO_RUNTIME_DIR;
  process.env.GH_MAESTRO_RUNTIME_DIR = runtime;
  const head = '1234567890abcdef1234567890abcdef12345678';
  try {
    const result = await mod.runSlowTest({
      pr: '44', issue: 461, repo: 'fixture/repo', workspace, headSha: head,
    }, {
      resolveSlowWorktreeFn: () => { throw new Error('slow worktree missing'); },
    });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.artifactPath, result.statePath);
    assert.ok(fs.existsSync(result.artifactPath));
    assert.ok(fs.existsSync(result.executionLogPath));
    assert.match(fs.readFileSync(result.executionLogPath, 'utf8'), /slow worktree missing/);
    const state = JSON.parse(fs.readFileSync(result.statePath, 'utf8'));
    assert.equal(state.runs[head].status, 'unavailable');
    assert.equal(state.runs[head].result.executionLogPath, result.executionLogPath);
  } finally {
    if (previousRuntime === undefined) delete process.env.GH_MAESTRO_RUNTIME_DIR;
    else process.env.GH_MAESTRO_RUNTIME_DIR = previousRuntime;
  }
});

test('runSlowTest records timeout/startup failures and does not retry a completed unavailable run', async () => {
  const { mod } = loadModule();
  const workspace = temporaryWorkspace('gh-maestro-poll-pr-run-failure-');
  const worktree = path.join(workspace, '.gh-maestro', 'worktrees', 'fixture-senior');
  fs.mkdirSync(worktree, { recursive: true });
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-poll-pr-runtime-'));
  const previousRuntime = process.env.GH_MAESTRO_RUNTIME_DIR;
  process.env.GH_MAESTRO_RUNTIME_DIR = runtime;
  const head = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';
  const child = new EventEmitter();
  let spawnCount = 0;
  const declareCalls = [];
  try {
    const deps = {
      resolveSlowWorktreeFn: () => ({ workerName: 'fixture-senior', worktree }),
      resolveGitHeadFn: () => head,
      spawnFn: () => { spawnCount++; return child; },
      waitChildExitFn: async () => { throw new Error('child did not exit after timeout'); },
      declareTestResultFn: (args) => {
        declareCalls.push(args);
        return { ok: true };
      },
    };
    const result = await mod.runSlowTest({
      pr: '43', issue: 461, repo: 'fixture/repo', workspace, headSha: head,
    }, deps);
    assert.equal(result.status, 'unavailable');
    assert.ok(fs.existsSync(result.executionLogPath));
    assert.match(fs.readFileSync(result.executionLogPath, 'utf8'), /child did not exit after timeout/);
    assert.ok(fs.existsSync(result.artifactPath));
    assert.equal(readTestResultArtifact(worktree).result.layers.slow.status, 'unavailable');
    assert.equal(declareCalls.length, 1);

    const second = await mod.runSlowTest({
      pr: '43', issue: 461, repo: 'fixture/repo', workspace, headSha: head,
    }, deps);
    assert.equal(second.status, 'unavailable');
    assert.equal(spawnCount, 1);
  } finally {
    if (previousRuntime === undefined) delete process.env.GH_MAESTRO_RUNTIME_DIR;
    else process.env.GH_MAESTRO_RUNTIME_DIR = previousRuntime;
  }
});

// ── CLI起動時の即時エラー終了パス（ループに入る前にexitするため実プロセスspawn可） ──

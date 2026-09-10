'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  readTestResultArtifact,
  writeTestResultLayer,
} = require('../scripts/shared/test-result');
const { createTempDirScope } = require('../scripts/shared/temp-directory');

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
    child.stdout = new PassThrough();
    const result = spawnSyncImpl ? spawnSyncImpl(cmd, args, opts) : { status: 0 };
    process.nextTick(() => {
      child.stdout.end(result && result.stdout ? result.stdout : '');
      child.emit('close', result && result.status);
    });
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

test('spawnPollReviews launches poll-reviews.js asynchronously and relays stdout', async () => {
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
  assert.deepEqual(call.opts.stdio, ['ignore', 'pipe', 'inherit']);
});

test('spawnPollReviews sends relayed PR_PUSH lines to the callback', async () => {
  const { mod, calls } = loadModule(() => ({ status: 0, stdout: 'PR_PUSH:0123456789abcdef0123456789abcdef01234567\n' }));
  const lines = [];
  await mod.spawnPollReviews('12', '/workspace', 4321, 30, (line) => lines.push(line));
  assert.deepEqual(lines, ['PR_PUSH:0123456789abcdef0123456789abcdef01234567']);
  assert.equal(calls.length, 1);
});

test('parsePrPushLine accepts a SHA and rejects unrelated or malformed output', () => {
  assert.equal(modParsePrPushLine('PR_PUSH:0123456789abcdef0123456789abcdef01234567'), '0123456789abcdef0123456789abcdef01234567');
  assert.equal(modParsePrPushLine('PR_COMMENT:owner:hello'), null);
  assert.equal(modParsePrPushLine('PR_PUSH:not-a-sha'), null);
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
const {
  resolvePostReviewDecision,
  parsePrPushLine: modParsePrPushLine,
} = require('../scripts/poll-pr');

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

const tempDirScope = createTempDirScope();

test.after(() => tempDirScope.cleanup());

function temporaryWorkspace(prefix) {
  const workspace = tempDirScope.mkdtemp(prefix);
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
  const runtime = tempDirScope.mkdtemp('gh-maestro-poll-pr-runtime-');
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

test('runPollPr connects PR detection, PR_PUSH slow launches, deduplication, and pending completion', async () => {
  const { mod } = loadModule();
  const workspace = temporaryWorkspace('gh-maestro-poll-pr-control-loop-');
  const worktree = path.join(workspace, '.gh-maestro', 'worktrees', 'fixture-senior');
  fs.mkdirSync(worktree, { recursive: true });
  const runtime = tempDirScope.mkdtemp('gh-maestro-poll-pr-runtime-');
  const previousRuntime = process.env.GH_MAESTRO_RUNTIME_DIR;
  process.env.GH_MAESTRO_RUNTIME_DIR = runtime;
  const firstHead = '1111111111111111111111111111111111111111';
  const pushedHead = '2222222222222222222222222222222222222222';
  const headChecks = [firstHead, firstHead, pushedHead, pushedHead];
  let headIndex = 0;
  let childStarts = 0;
  let managerStarts = 0;
  let h2Started = false;
  let releasePushedSlow;
  const pushedSlowRelease = new Promise((resolve) => { releasePushedSlow = resolve; });
  let cleanupCode;
  let pollCall;
  const output = [];
  try {
    const runPromise = mod.runPollPr({
      issue: 465,
      repo: 'fixture/repo',
      workspace,
      sessionPid: 4321,
      noReviewManager: false,
      intervalMs: 0,
      intervalArg: '0',
    }, {
      checkParentFn: () => true,
      findPrFn: () => '42',
      getPrHeadFn: () => firstHead,
      startReviewManagerFn: () => {
        managerStarts += 1;
        return 'REVIEW_MANAGER_STARTED';
      },
      spawnPollReviewsFn: async (pr, reviewWorkspace, sessionPid, interval, onOutputLine) => {
        pollCall = { pr, reviewWorkspace, sessionPid, interval };
        onOutputLine(`PR_PUSH:${pushedHead}`);
        onOutputLine(`PR_PUSH:${pushedHead}`);
        return 0;
      },
      getPrStateFn: () => 'OPEN',
      recordMergeAndSnapshotFn: () => {},
      cleanupFn: (code) => { cleanupCode = code; },
      writeStdoutFn: (text) => output.push(text),
      slowTestDeps: {
        resolveSlowWorktreeFn: () => ({ workerName: 'fixture-senior', worktree }),
        resolveGitHeadFn: () => headChecks[headIndex++],
        getPrHeadFn: () => (childStarts <= 1 ? firstHead : pushedHead),
        spawnFn: () => ({ pid: 9000 + childStarts }),
        waitChildExitFn: async ({ onCleanup }) => {
          childStarts += 1;
          const currentHead = childStarts === 1 ? firstHead : pushedHead;
          if (currentHead === pushedHead) {
            h2Started = true;
            await pushedSlowRelease;
          }
          writeTestResultLayer(worktree, completeLayer('slow', currentHead));
          onCleanup();
          return 0;
        },
        declareTestResultFn: () => ({ ok: true }),
      },
    });

    // Allow the real control loop to reach the pushed slow child without sleeping.
    for (let i = 0; i < 20 && !h2Started; i += 1) await Promise.resolve();
    assert.equal(h2Started, true);

    let settled = false;
    runPromise.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false, 'poll-pr must wait for pending slow work');

    releasePushedSlow();
    const result = await runPromise;
    assert.deepEqual(result, { exitCode: 0 });
    assert.equal(cleanupCode, 0);
    assert.equal(managerStarts, 1, 'Review Manager is claimed and started once for the PR');
    assert.deepEqual(pollCall, {
      pr: '42',
      reviewWorkspace: workspace,
      sessionPid: 4321,
      interval: '0',
    });
    assert.equal(childStarts, 2, 'initial HEAD and one pushed HEAD should execute once each');
    assert.deepEqual(
      output.filter((line) => line.startsWith('SLOW_TEST_STARTED:')).map((line) => JSON.parse(line.slice('SLOW_TEST_STARTED:'.length)).testedHead),
      [firstHead, pushedHead],
    );
    assert.ok(output.includes('REVIEW_MANAGER_STARTED:42\n'));
    const state = JSON.parse(fs.readFileSync(mod.slowStatePath(workspace, '42'), 'utf8'));
    assert.equal(state.runs[firstHead].status, 'pass');
    assert.equal(state.runs[pushedHead].status, 'pass');
  } finally {
    if (releasePushedSlow) releasePushedSlow();
    if (previousRuntime === undefined) delete process.env.GH_MAESTRO_RUNTIME_DIR;
    else process.env.GH_MAESTRO_RUNTIME_DIR = previousRuntime;
  }
});

test('runPollPr skips automatic Review Manager restart after the same PR is detected again', async () => {
  const { mod } = loadModule();
  const workspace = temporaryWorkspace('gh-maestro-poll-pr-claim-redetect-');
  const states = ['CLOSED', 'OPEN'];
  const output = [];
  let managerStarts = 0;
  let childStarts = 0;
  const result = await mod.runPollPr({
    issue: 507,
    repo: 'fixture/repo',
    workspace,
    sessionPid: 4321,
    intervalMs: 0,
    intervalArg: '0',
  }, {
    checkParentFn: () => true,
    findPrFn: () => '42',
    getPrHeadFn: () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    startReviewManagerFn: () => {
      managerStarts += 1;
      return 'REVIEW_MANAGER_STARTED';
    },
    spawnPollReviewsFn: async () => {
      childStarts += 1;
      return 0;
    },
    getPrStateFn: () => states.shift() || 'OPEN',
    recordMergeAndSnapshotFn: () => {},
    runSlowTestFn: async () => {},
    cleanupFn: () => {},
    writeStdoutFn: (text) => output.push(text),
  });

  assert.deepEqual(result, { exitCode: 0 });
  assert.equal(childStarts, 2);
  assert.equal(managerStarts, 1);
  assert.ok(output.includes('REVIEW_MANAGER_STARTED:42\n'));
  assert.ok(output.includes('REVIEW_MANAGER_ALREADY_CLAIMED:42\n'));
  assert.equal(fs.existsSync(mod.reviewManagerClaimPath(workspace, '42')), true);
});

test('runPollPr claims and starts a different PR after the previous PR closes', async () => {
  const { mod } = loadModule();
  const workspace = temporaryWorkspace('gh-maestro-poll-pr-claim-distinct-');
  const prs = ['42', '43'];
  const states = ['CLOSED', 'OPEN'];
  const started = [];
  const output = [];
  const result = await mod.runPollPr({
    issue: 507,
    repo: 'fixture/repo',
    workspace,
    sessionPid: 4321,
    intervalMs: 0,
    intervalArg: '0',
  }, {
    checkParentFn: () => true,
    findPrFn: () => prs.shift() || '43',
    getPrHeadFn: () => 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    startReviewManagerFn: (pr) => {
      started.push(String(pr));
      return 'REVIEW_MANAGER_STARTED';
    },
    spawnPollReviewsFn: async () => 0,
    getPrStateFn: () => states.shift() || 'OPEN',
    recordMergeAndSnapshotFn: () => {},
    runSlowTestFn: async () => {},
    cleanupFn: () => {},
    writeStdoutFn: (text) => output.push(text),
  });

  assert.deepEqual(result, { exitCode: 0 });
  assert.deepEqual(started, ['42', '43']);
  assert.ok(output.includes('REVIEW_MANAGER_STARTED:42\n'));
  assert.ok(output.includes('REVIEW_MANAGER_STARTED:43\n'));
  assert.equal(fs.existsSync(mod.reviewManagerClaimPath(workspace, '42')), true);
  assert.equal(fs.existsSync(mod.reviewManagerClaimPath(workspace, '43')), true);
});

test('runPollPr --no-review-manager does not claim, start, or emit Review Manager output', async () => {
  const { mod } = loadModule();
  const workspace = temporaryWorkspace('gh-maestro-poll-pr-no-review-manager-');
  const output = [];
  let managerStarts = 0;
  const result = await mod.runPollPr({
    issue: 507,
    repo: 'fixture/repo',
    workspace,
    sessionPid: 4321,
    noReviewManager: true,
    intervalMs: 0,
    intervalArg: '0',
  }, {
    checkParentFn: () => true,
    findPrFn: () => '42',
    getPrHeadFn: () => 'cccccccccccccccccccccccccccccccccccccccc',
    startReviewManagerFn: () => {
      managerStarts += 1;
      return 'REVIEW_MANAGER_STARTED';
    },
    spawnPollReviewsFn: async () => 0,
    getPrStateFn: () => 'OPEN',
    recordMergeAndSnapshotFn: () => {},
    runSlowTestFn: async () => {},
    cleanupFn: () => {},
    writeStdoutFn: (text) => output.push(text),
  });

  assert.deepEqual(result, { exitCode: 0 });
  assert.equal(managerStarts, 0);
  assert.equal(output.some((line) => line.includes('REVIEW_MANAGER_')), false);
  assert.equal(fs.existsSync(mod.reviewManagerClaimPath(workspace, '42')), false);
});

test('runPollPr leaves the claim sentinel when automatic Review Manager startup fails', async () => {
  const { mod } = loadModule();
  const workspace = temporaryWorkspace('gh-maestro-poll-pr-claim-failure-');
  await assert.rejects(() => mod.runPollPr({
    issue: 507,
    repo: 'fixture/repo',
    workspace,
    sessionPid: 4321,
    intervalMs: 0,
    intervalArg: '0',
  }, {
    checkParentFn: () => true,
    findPrFn: () => '42',
    getPrHeadFn: () => 'dddddddddddddddddddddddddddddddddddddddd',
    startReviewManagerFn: () => { throw new Error('startup failed'); },
    spawnPollReviewsFn: async () => { throw new Error('must not monitor after startup failure'); },
    getPrStateFn: () => 'OPEN',
    recordMergeAndSnapshotFn: () => {},
    runSlowTestFn: async () => {},
    cleanupFn: () => {},
  }), /startup failed/);

  const claimPath = mod.reviewManagerClaimPath(workspace, '42');
  assert.equal(fs.existsSync(claimPath), true);
  assert.equal(fs.readFileSync(claimPath, 'utf8'), '');
});

test('claimReviewManagerLaunch creates one empty sentinel and rejects the second claim', () => {
  const { mod } = loadModule();
  const workspace = temporaryWorkspace('gh-maestro-poll-pr-claim-sentinel-');
  const first = mod.claimReviewManagerLaunch(workspace, '42');
  const second = mod.claimReviewManagerLaunch(workspace, '42');

  assert.deepEqual(first, { claimed: true, claimPath: mod.reviewManagerClaimPath(workspace, '42') });
  assert.deepEqual(second, { claimed: false, claimPath: mod.reviewManagerClaimPath(workspace, '42') });
  assert.equal(fs.readFileSync(first.claimPath, 'utf8'), '');
});

test('runSlowTest uses a matching existing worktree and preserves the full layer', async () => {
  const { mod } = loadModule();
  const workspace = temporaryWorkspace('gh-maestro-poll-pr-run-slow-');
  const worktree = path.join(workspace, '.gh-maestro', 'worktrees', 'fixture-senior');
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(workspace, '.gh-maestro', 'workers.json'), JSON.stringify({
    'fixture-senior': { issue: 461, skill: 'gh-maestro-senior-coder' },
  }), 'utf8');
  const runtime = tempDirScope.mkdtemp('gh-maestro-poll-pr-runtime-');
  const previousRuntime = process.env.GH_MAESTRO_RUNTIME_DIR;
  process.env.GH_MAESTRO_RUNTIME_DIR = runtime;
  const head = '0123456789abcdef0123456789abcdef01234567';
  const child = new EventEmitter();
  child.pid = 1234;
  const declareCalls = [];
  const reserved = [];
  let spawnOptions;
  try {
    writeTestResultLayer(worktree, completeLayer('full', head));
    const result = await mod.runSlowTest({
      pr: '42', issue: 461, repo: 'fixture/repo', workspace, headSha: head,
    }, {
      resolveGitHeadFn: () => head,
      getPrHeadFn: () => head,
      createTempDirScopeFn: () => { throw new Error('matching worktree must not use detached fallback'); },
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
      onReserved: (event) => reserved.push(event),
    });

    assert.equal(result.status, 'pass');
    assert.equal(result.testedHead, head);
    assert.deepEqual(reserved, [{ pr: '42', layer: 'slow', testedHead: head }]);
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

test('runSlowTest falls back to a detached worktree without workers.json', async () => {
  const { mod } = loadModule();
  const workspace = temporaryWorkspace('gh-maestro-poll-pr-detached-fallback-');
  const runtime = tempDirScope.mkdtemp('gh-maestro-poll-pr-runtime-');
  const previousRuntime = process.env.GH_MAESTRO_RUNTIME_DIR;
  process.env.GH_MAESTRO_RUNTIME_DIR = runtime;
  const head = '1234567890abcdef1234567890abcdef12345678';
  const tempRoot = tempDirScope.mkdtemp('gh-maestro-poll-pr-detached-root-');
  const events = [];
  let detachedWorktree;
  const child = new EventEmitter();
  child.pid = 1234;
  const declareCalls = [];
  try {
    const result = await mod.runSlowTest({
      pr: '44', issue: 461, repo: 'fixture/repo', workspace, headSha: head,
    }, {
      resolveSlowWorktreeFn: () => null,
      createTempDirScopeFn: () => ({
        mkdtemp: (prefix) => { events.push(`mkdtemp:${prefix}`); return tempRoot; },
        cleanup: () => { events.push('scope.cleanup'); },
      }),
      worktreeAddDetachedFn: (worktreeDir, sha, cwd) => {
        events.push('worktree.add');
        detachedWorktree = worktreeDir;
        assert.equal(sha, head);
        assert.equal(cwd, workspace);
        fs.mkdirSync(worktreeDir, { recursive: true });
      },
      resolveGitHeadFn: (worktreeDir) => {
        assert.equal(worktreeDir, detachedWorktree);
        return head;
      },
      linkNodeModulesFn: (worktreeDir, cwd) => {
        events.push('link-node-modules');
        assert.equal(worktreeDir, detachedWorktree);
        assert.equal(cwd, workspace);
        return { linked: [], skipped: [], missing: [] };
      },
      spawnFn: (_command, _args, options) => {
        assert.equal(options.cwd, detachedWorktree);
        return child;
      },
      waitChildExitFn: async ({ onCleanup }) => {
        writeTestResultLayer(detachedWorktree, completeLayer('slow', head));
        onCleanup();
        return 0;
      },
      getPrHeadFn: () => head,
      declareTestResultFn: (args) => {
        declareCalls.push(args);
        assert.equal(args.worktree, detachedWorktree);
        return { ok: true };
      },
      unlinkJunctionsFn: (worktreeDir) => {
        events.push('junctions.unlink');
        assert.equal(worktreeDir, detachedWorktree);
      },
      worktreeRemoveFn: (worktreeDir, cwd) => {
        events.push('worktree.remove');
        assert.equal(worktreeDir, detachedWorktree);
        assert.equal(cwd, workspace);
      },
    });
    assert.equal(result.status, 'pass');
    assert.equal(result.testedHead, head);
    assert.equal(declareCalls.length, 1);
    assert.equal(fs.existsSync(path.join(workspace, '.gh-maestro', 'workers.json')), false);
    assert.deepEqual(events, [
      'mkdtemp:gh-maestro-slow-pr-',
      'worktree.add',
      'link-node-modules',
      'junctions.unlink',
      'worktree.remove',
      'scope.cleanup',
    ]);
    assert.ok(fs.existsSync(result.artifactPath));
    assert.ok(fs.existsSync(result.executionLogPath));
    const state = JSON.parse(fs.readFileSync(result.statePath, 'utf8'));
    assert.equal(state.runs[head].status, 'pass');
  } finally {
    if (previousRuntime === undefined) delete process.env.GH_MAESTRO_RUNTIME_DIR;
    else process.env.GH_MAESTRO_RUNTIME_DIR = previousRuntime;
  }
});

test('runSlowTest falls back when an existing worktree HEAD does not match', async () => {
  const { mod } = loadModule();
  const workspace = temporaryWorkspace('gh-maestro-poll-pr-detached-mismatch-');
  const existingWorktree = path.join(workspace, '.gh-maestro', 'worktrees', 'fixture-coder');
  fs.mkdirSync(existingWorktree, { recursive: true });
  const runtime = tempDirScope.mkdtemp('gh-maestro-poll-pr-runtime-');
  const previousRuntime = process.env.GH_MAESTRO_RUNTIME_DIR;
  process.env.GH_MAESTRO_RUNTIME_DIR = runtime;
  const head = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';
  const oldHead = '1111111111111111111111111111111111111111';
  const tempRoot = tempDirScope.mkdtemp('gh-maestro-poll-pr-detached-root-');
  const events = [];
  let detachedWorktree;
  const child = new EventEmitter();
  child.pid = 1235;
  try {
    const result = await mod.runSlowTest({
      pr: '46', issue: 461, repo: 'fixture/repo', workspace, headSha: head,
    }, {
      resolveSlowWorktreeFn: () => ({ workerName: 'fixture-coder', worktree: existingWorktree }),
      createTempDirScopeFn: () => ({
        mkdtemp: () => tempRoot,
        cleanup: () => { events.push('scope.cleanup'); },
      }),
      worktreeAddDetachedFn: (worktreeDir, sha) => {
        events.push('worktree.add');
        detachedWorktree = worktreeDir;
        assert.equal(sha, head);
        fs.mkdirSync(worktreeDir, { recursive: true });
      },
      resolveGitHeadFn: (worktreeDir) => worktreeDir === existingWorktree ? oldHead : head,
      linkNodeModulesFn: () => {
        events.push('link-node-modules');
        return { linked: [], skipped: [], missing: [] };
      },
      spawnFn: () => child,
      waitChildExitFn: async ({ onCleanup }) => {
        writeTestResultLayer(detachedWorktree, completeLayer('slow', head));
        onCleanup();
        return 0;
      },
      getPrHeadFn: () => head,
      declareTestResultFn: ({ worktree }) => {
        assert.equal(worktree, detachedWorktree);
        return { ok: true };
      },
      unlinkJunctionsFn: (worktreeDir) => {
        events.push('junctions.unlink');
        assert.equal(worktreeDir, detachedWorktree);
      },
      worktreeRemoveFn: (worktreeDir) => {
        events.push('worktree.remove');
        assert.equal(worktreeDir, detachedWorktree);
      },
    });
    assert.equal(result.status, 'pass');
    assert.equal(fs.existsSync(existingWorktree), true);
    assert.deepEqual(events, [
      'worktree.add',
      'link-node-modules',
      'junctions.unlink',
      'worktree.remove',
      'scope.cleanup',
    ]);
  } finally {
    if (previousRuntime === undefined) delete process.env.GH_MAESTRO_RUNTIME_DIR;
    else process.env.GH_MAESTRO_RUNTIME_DIR = previousRuntime;
  }
});

test('runSlowTest treats detached dependency preparation failure as unavailable', async () => {
  const { mod } = loadModule();
  const workspace = temporaryWorkspace('gh-maestro-poll-pr-detached-dependency-failure-');
  const runtime = tempDirScope.mkdtemp('gh-maestro-poll-pr-runtime-');
  const previousRuntime = process.env.GH_MAESTRO_RUNTIME_DIR;
  process.env.GH_MAESTRO_RUNTIME_DIR = runtime;
  const head = 'fedcbafedcbafedcbafedcbafedcbafedcbafedc';
  const tempRoot = tempDirScope.mkdtemp('gh-maestro-poll-pr-detached-root-');
  const events = [];
  let detachedWorktree;
  let spawnCount = 0;
  const declareCalls = [];
  try {
    const result = await mod.runSlowTest({
      pr: '47', issue: 461, repo: 'fixture/repo', workspace, headSha: head,
    }, {
      resolveSlowWorktreeFn: () => null,
      createTempDirScopeFn: () => ({
        mkdtemp: () => tempRoot,
        cleanup: () => { events.push('scope.cleanup'); },
      }),
      worktreeAddDetachedFn: (worktreeDir) => {
        events.push('worktree.add');
        detachedWorktree = worktreeDir;
        fs.mkdirSync(worktreeDir, { recursive: true });
      },
      resolveGitHeadFn: () => head,
      linkNodeModulesFn: () => {
        events.push('link-node-modules');
        return { linked: [], skipped: [], missing: ['node_modules (error: denied)'] };
      },
      spawnFn: () => { spawnCount += 1; return new EventEmitter(); },
      getPrHeadFn: () => head,
      declareTestResultFn: (args) => {
        declareCalls.push(args);
        events.push('declare');
        assert.equal(args.pr, '47');
        assert.equal(args.headSha, head);
        assert.equal(args.worktree, detachedWorktree);
        return { ok: true };
      },
      unlinkJunctionsFn: (worktreeDir) => {
        events.push('junctions.unlink');
        assert.equal(worktreeDir, detachedWorktree);
      },
      worktreeRemoveFn: (worktreeDir) => {
        events.push('worktree.remove');
        assert.equal(worktreeDir, detachedWorktree);
      },
    });
    assert.equal(result.status, 'unavailable');
    assert.match(result.error, /node_modules/);
    assert.equal(spawnCount, 0);
    assert.equal(declareCalls.length, 1);
    assert.deepEqual(events, [
      'worktree.add',
      'link-node-modules',
      'declare',
      'junctions.unlink',
      'worktree.remove',
      'scope.cleanup',
    ]);
  } finally {
    if (previousRuntime === undefined) delete process.env.GH_MAESTRO_RUNTIME_DIR;
    else process.env.GH_MAESTRO_RUNTIME_DIR = previousRuntime;
  }
});

test('runSlowTest keeps a non-zero slow test outcome as fail', async () => {
  const { mod } = loadModule();
  const workspace = temporaryWorkspace('gh-maestro-poll-pr-slow-fail-');
  const worktree = path.join(workspace, '.gh-maestro', 'worktrees', 'fixture-senior');
  fs.mkdirSync(worktree, { recursive: true });
  const runtime = tempDirScope.mkdtemp('gh-maestro-poll-pr-runtime-');
  const previousRuntime = process.env.GH_MAESTRO_RUNTIME_DIR;
  process.env.GH_MAESTRO_RUNTIME_DIR = runtime;
  const head = '9999999999999999999999999999999999999999';
  const child = new EventEmitter();
  child.pid = 1236;
  try {
    const result = await mod.runSlowTest({
      pr: '48', issue: 461, repo: 'fixture/repo', workspace, headSha: head,
    }, {
      resolveSlowWorktreeFn: () => ({ workerName: 'fixture-senior', worktree }),
      resolveGitHeadFn: () => head,
      getPrHeadFn: () => head,
      spawnFn: () => child,
      waitChildExitFn: async ({ onCleanup }) => {
        writeTestResultLayer(worktree, {
          ...completeLayer('slow', head),
          outcome: 'fail',
          pass: 0,
          fail: 1,
        });
        onCleanup();
        return 1;
      },
      declareTestResultFn: () => ({ ok: true }),
    });
    assert.equal(result.status, 'fail');
    assert.equal(result.outcome, 'fail');
    assert.equal(result.exitCode, 1);
  } finally {
    if (previousRuntime === undefined) delete process.env.GH_MAESTRO_RUNTIME_DIR;
    else process.env.GH_MAESTRO_RUNTIME_DIR = previousRuntime;
  }
});

test('runSlowTest propagates unavailable command and reason to SLOW_TEST_RESULT', async () => {
  const { mod } = loadModule();
  const workspace = temporaryWorkspace('gh-maestro-poll-pr-slow-unavailable-');
  const worktree = path.join(workspace, '.gh-maestro', 'worktrees', 'fixture-senior');
  fs.mkdirSync(worktree, { recursive: true });
  const runtime = tempDirScope.mkdtemp('gh-maestro-poll-pr-runtime-');
  const previousRuntime = process.env.GH_MAESTRO_RUNTIME_DIR;
  process.env.GH_MAESTRO_RUNTIME_DIR = runtime;
  const head = '8888888888888888888888888888888888888888';
  const child = new EventEmitter();
  const output = captureStdout();
  const reason = "runner-abnormal-exit: command: npm run test:slow; stderr: Cannot find module './tests/_env-setup.js'";
  try {
    const result = await mod.runSlowTest({
      pr: '481', issue: 461, repo: 'fixture/repo', workspace, headSha: head,
    }, {
      resolveSlowWorktreeFn: () => ({ workerName: 'fixture-senior', worktree }),
      resolveGitHeadFn: () => head,
      getPrHeadFn: () => head,
      spawnFn: () => child,
      waitChildExitFn: async ({ onCleanup }) => {
        writeTestResultLayer(worktree, {
          layer: 'slow',
          scope: 'partial',
          status: 'unavailable',
          command: 'npm run test:slow',
          recordedAt: '2026-09-10T00:00:00.000Z',
          executor: 'poll-pr',
          testedHead: head,
          reason,
        });
        onCleanup();
        return 1;
      },
      declareTestResultFn: () => ({ ok: true }),
    });

    assert.equal(result.status, 'unavailable');
    assert.equal(result.command, 'npm run test:slow');
    assert.equal(result.reason, reason);
    const event = JSON.parse(output.output().trim().slice('SLOW_TEST_RESULT:'.length));
    assert.equal(event.status, 'unavailable');
    assert.equal(event.command, 'npm run test:slow');
    assert.equal(event.reason, reason);
  } finally {
    output.restore();
    if (previousRuntime === undefined) delete process.env.GH_MAESTRO_RUNTIME_DIR;
    else process.env.GH_MAESTRO_RUNTIME_DIR = previousRuntime;
  }
});

test('runSlowTest treats PR HEAD lookup failures as unknown, not stale', async (t) => {
  for (const { name, pr, getPrHeadFn } of [
    { name: 'empty response', pr: '50', getPrHeadFn: () => '' },
    { name: 'thrown exception', pr: '51', getPrHeadFn: () => { throw new Error('gh unavailable'); } },
  ]) {
    await t.test(name, async () => {
      const { mod } = loadModule();
      const workspace = temporaryWorkspace(`gh-maestro-poll-pr-pr-head-${pr}-`);
      const worktree = path.join(workspace, '.gh-maestro', 'worktrees', 'fixture-senior');
      fs.mkdirSync(worktree, { recursive: true });
      const runtime = tempDirScope.mkdtemp(`gh-maestro-poll-pr-runtime-${pr}-`);
      const previousRuntime = process.env.GH_MAESTRO_RUNTIME_DIR;
      process.env.GH_MAESTRO_RUNTIME_DIR = runtime;
      const head = '5555555555555555555555555555555555555555';
      const child = new EventEmitter();
      child.pid = 1238;
      let declareCalls = 0;
      try {
        const result = await mod.runSlowTest({
          pr, issue: 461, repo: 'fixture/repo', workspace, headSha: head,
        }, {
          resolveSlowWorktreeFn: () => ({ workerName: 'fixture-senior', worktree }),
          resolveGitHeadFn: () => head,
          spawnFn: () => child,
          waitChildExitFn: async ({ onCleanup }) => {
            writeTestResultLayer(worktree, completeLayer('slow', head));
            onCleanup();
            return 0;
          },
          getPrHeadFn,
          declareTestResultFn: (args) => {
            declareCalls += 1;
            assert.equal(args.headSha, head);
            return { ok: true };
          },
        });
        assert.equal(result.status, 'pass');
        assert.equal(result.testedHead, head);
        assert.equal(declareCalls, 1);
      } finally {
        if (previousRuntime === undefined) delete process.env.GH_MAESTRO_RUNTIME_DIR;
        else process.env.GH_MAESTRO_RUNTIME_DIR = previousRuntime;
      }
    });
  }
});

test('runSlowTest records timeout/startup failures and does not retry a completed unavailable run', async () => {
  const { mod } = loadModule();
  const workspace = temporaryWorkspace('gh-maestro-poll-pr-run-failure-');
  const worktree = path.join(workspace, '.gh-maestro', 'worktrees', 'fixture-senior');
  fs.mkdirSync(worktree, { recursive: true });
  const runtime = tempDirScope.mkdtemp('gh-maestro-poll-pr-runtime-');
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
      getPrHeadFn: () => head,
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
    assert.equal(result.command, 'npm run test:slow');
    assert.equal(result.reason, 'child did not exit after timeout');
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

test('runSlowTest does not let an older HEAD overwrite a newer worktree result', async () => {
  const { mod } = loadModule();
  const workspace = temporaryWorkspace('gh-maestro-poll-pr-stale-head-');
  const worktree = path.join(workspace, '.gh-maestro', 'worktrees', 'fixture-senior');
  fs.mkdirSync(worktree, { recursive: true });
  const runtime = tempDirScope.mkdtemp('gh-maestro-poll-pr-runtime-');
  const previousRuntime = process.env.GH_MAESTRO_RUNTIME_DIR;
  process.env.GH_MAESTRO_RUNTIME_DIR = runtime;
  const head = '1111111111111111111111111111111111111111';
  const newerHead = '2222222222222222222222222222222222222222';
  const child = new EventEmitter();
  child.pid = 1234;
  let headCalls = 0;
  let artifactWrites = 0;
  let declareCalls = 0;
  try {
    const result = await mod.runSlowTest({
      pr: '45', issue: 461, repo: 'fixture/repo', workspace, headSha: head,
    }, {
      resolveSlowWorktreeFn: () => ({ workerName: 'fixture-senior', worktree }),
      resolveGitHeadFn: () => {
        headCalls += 1;
        return headCalls === 1 ? head : newerHead;
      },
      spawnFn: () => child,
      waitChildExitFn: async () => 0,
      writeTestResultLayerFn: () => { artifactWrites += 1; },
      declareTestResultFn: () => { declareCalls += 1; return { ok: true }; },
    });

    assert.equal(result.status, 'unavailable');
    assert.match(result.error, /HEADが実行中に変更/);
    assert.equal(artifactWrites, 0);
    assert.equal(declareCalls, 0);
    const state = JSON.parse(fs.readFileSync(mod.slowStatePath(workspace, '45'), 'utf8'));
    assert.equal(state.runs[head].status, 'unavailable');
  } finally {
    if (previousRuntime === undefined) delete process.env.GH_MAESTRO_RUNTIME_DIR;
    else process.env.GH_MAESTRO_RUNTIME_DIR = previousRuntime;
  }
});

test('runSlowTest does not declare when the PR HEAD changes before declaration', async () => {
  const { mod } = loadModule();
  const workspace = temporaryWorkspace('gh-maestro-poll-pr-stale-pr-head-');
  const worktree = path.join(workspace, '.gh-maestro', 'worktrees', 'fixture-senior');
  fs.mkdirSync(worktree, { recursive: true });
  const runtime = tempDirScope.mkdtemp('gh-maestro-poll-pr-runtime-');
  const previousRuntime = process.env.GH_MAESTRO_RUNTIME_DIR;
  process.env.GH_MAESTRO_RUNTIME_DIR = runtime;
  const head = '3333333333333333333333333333333333333333';
  const newerHead = '4444444444444444444444444444444444444444';
  const child = new EventEmitter();
  child.pid = 1237;
  let declareCalls = 0;
  let prHeadCalls = 0;
  try {
    const result = await mod.runSlowTest({
      pr: '49', issue: 461, repo: 'fixture/repo', workspace, headSha: head,
    }, {
      resolveSlowWorktreeFn: () => ({ workerName: 'fixture-senior', worktree }),
      resolveGitHeadFn: () => head,
      spawnFn: () => child,
      waitChildExitFn: async ({ onCleanup }) => {
        writeTestResultLayer(worktree, completeLayer('slow', head));
        onCleanup();
        return 0;
      },
      getPrHeadFn: () => {
        prHeadCalls += 1;
        return prHeadCalls === 1 ? head : newerHead;
      },
      declareTestResultFn: () => { declareCalls += 1; return { ok: true }; },
    });
    assert.equal(result.status, 'unavailable');
    assert.match(result.error, /PR HEADが実行対象SHAと一致しない/);
    assert.equal(declareCalls, 0);
  } finally {
    if (previousRuntime === undefined) delete process.env.GH_MAESTRO_RUNTIME_DIR;
    else process.env.GH_MAESTRO_RUNTIME_DIR = previousRuntime;
  }
});

// ── CLI起動時の即時エラー終了パス（ループに入る前にexitするため実プロセスspawn可） ──

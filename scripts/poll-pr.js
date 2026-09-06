#!/usr/bin/env node
// Usage: node poll-pr.js <ISSUE> [--workspace <path>] [--session-pid <pid>] [--base-branch <branch>] [INTERVAL_SECONDS]
// Polls until a PR for the given issue is found, then launches the reviewer
// (全観点。観点を絞り込むかどうかの判断はReview Manager自身が実際のdiffを見て行う —
// オーケストレーターや機械的ロジックが観点を絞り込むことはしない）
// and bridges into poll-reviews.js as a child process. Prints:
//   PR_BASE_MISMATCH:<PR>:<expected>:<actual>  (only when --base-branch and actual base branch mismatch)
//   PR_DETECTED:<number>
//   REVIEW_MANAGER_STARTED:<number> | REVIEW_MANAGER_ALREADY_RUNNING:<number>
//   ...poll-reviews.js の出力がそのまま続く（REVIEW_COMMENT / PR_COMMENT / PR_REVIEW / PR_PUSH / PR_MERGED / PR_CLOSED / POLL_ERROR / POLL_RECOVERED）。
//   PR_PUSHを受け取るたび、そのSHAのslow層を非同期で予約する。
//   Review Managerの起動後のクラッシュ（エージェントCLI起動失敗等）は、本スクリプトの
//   出力ではなく、通常ワーカーと同じ終了フック経由でIssueコメントとして非同期に通知される
//   （start-review-manager.js参照）。本スクリプトはそれを待たずPR/レビュー監視を継続する。
'use strict';

const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('./shared/child-process');
const { startReviewManager } = require('./start-review-manager');
const { waitChildExit } = require('./shared/child-wait');
const { killProcessTree } = require('./shared/kill-tree');
const { resolveWorkspace, parseFlags } = require('./shared/workspace');
const { resolveGitHead } = require('./shared/git-head');
const { atomicWriteJson } = require('./shared/atomic-write');
const { workspaceRuntimeDir } = require('./shared/storage-layout');
const { readWorkersRaw, resolveWorkerName } = require('./shared/workers-registry');
const { readTestResultArtifact, testResultPath, writeTestResultLayer } = require('./shared/test-result');
const { declareTestResult } = require('./declare-test-result');
const { notifyWatchdogExit } = require('./shared/watchdog-exit-notify');
const { recordCycleEvent } = require('./shared/cycle-metrics');
const { postCycleSnapshot } = require('./shared/cycle-snapshot');
const {
  resolveSessionPid,
  createDeadManSwitch,
  getProcessStartTime,
  registerProcess,
  cleanup: lifecycleCleanup,
} = require('./process-lifecycle');

const USAGE = `poll-pr.js — Issue に対応する PR を検出し、検出時にレビュアーを起動し、
その後 poll-reviews.js に処理を橋渡ししてレビュー監視を続行する

Usage: node poll-pr.js <ISSUE> [--workspace <path>] [--session-pid <pid>] [--base-branch <branch>] [INTERVAL_SECONDS]

Arguments:
  <ISSUE>             対象の Issue 番号（必須）
  [INTERVAL_SECONDS]  ポーリング間隔（秒、デフォルト 30）

Options:
  --no-review-manager        PR検出時に Review Manager を起動せず、レビュー監視だけを再開する。
                             既にレビュー済み／再レビュー不要な状態で poll-pr.js を再起動するときに使う
                             （再起動のたびにレビューを蒸し返すのを防ぐ）。
  --workspace <path>         ワークスペースパス（省略時は環境変数またはCWDから解決）
  --session-pid <pid>        監視対象のセッションPID（dead-man's switch用。省略時は自動検出）
  --base-branch <branch>     期待するベースブランチ名（省略時はベースブランチ検証をスキップ）

Output (stdout):
  PR_BASE_MISMATCH:<PR>:<expected>:<actual>  ベースブランチ不一致を検出（--base-branch指定時のみ）
  PR_DETECTED:<PR>                     PR を検出した
  REVIEW_MANAGER_STARTED:<PR>          Review Manager を起動した
  REVIEW_MANAGER_ALREADY_RUNNING:<PR>  Review Manager は既に稼働中
  PR_CLOSED_RESUMED:<PR>               監視していたPRがクローズされ、新PR検出に復帰した
  SLOW_TEST_STARTED:<json>             PR検出後のslow層を非同期で開始した
  SLOW_TEST_RESULT:<json>              slow層の完了または失敗を記録した
  以降、poll-reviews.js を子プロセスとして起動し、その標準出力（REVIEW_COMMENT/PR_COMMENT/
  PR_REVIEW/PR_PUSH/PR_MERGED/PR_CLOSED）をそのまま中継する。PR_PUSHを受け取ったHEADごとに
  slow層を非同期で予約し、同じPR/HEAD/layerはstate予約で二重実行しない。poll-reviews.js が正常終了
  （exit 0）かつ PR_CLOSED で終了したときは、新 PR の検出（findPR ループ）へ復帰して監視を
  継続する。子が非ゼロ終了・シグナル終了（SIGKILL等）した場合は PR 状態に関わらず、
  その終了コードでこのプロセスも終了して監視停止を通知する（子自身の exit 通知が実行できなくても
  親が異常終了通知で監視停止を届ける）。それ以外（MERGED 等・正常終了）も、その終了コードで
  このプロセスを終了する。
  Review Manager起動後のクラッシュはこの標準出力では通知されない（start-review-manager.js
  参照。Issueコメントとして別経路で届く）。PR/レビュー監視はそれとは独立して継続する。

PR が見つかるまでブロックし、見つけたら Review Manager(start-review-manager.js)を
全観点で起動し（skills/gh-maestro-reviewer/SKILL.md参照）、続けて poll-reviews.js を
子プロセスとして起動してレビュー監視を引き継いでから終了する。観点を絞り込む判断は
Review Manager自身が実際のdiffを見た上で行う（本スクリプトはファイルパターン等による
機械的な観点選定を一切行わない。ファイル名に基づく自動判定が一部の観点だけに絞り込んでしまい
他の観点のレビューが丸ごと欠落する実障害があったため、この責務はオーケストレーター側からは
完全に排除した）。slow層はPR検出後と修正pushごとに対象worktreeで非同期実行し、レビュー監視を
ブロックせず、完了時に層別成果物と申告コメントを更新する。
ポーリングループの毎周回で親セッションの生存を確認し（dead-man's switch）、
消滅時はPID registryを解除して自動exitする。`;

/**
 * poll-reviews.js を子プロセスとして起動し、その標準出力/標準エラーを自プロセスへ
 * 中継しながら終了を待つ。シェルのパイプ+ループではなくNode内の子プロセスとして
 * 起動することで、サブシェルの変数スコープ問題を避ける（Issue #111）。
 *
 * @param {string} pr
 * @param {string} workspace
 * @param {string|number} sessionPid
 * @param {string|number} [intervalSeconds]
 * @param {(line:string)=>void} [onOutputLine] poll-reviews.jsのstdoutを受け取るcallback
 * @returns {Promise<number>} poll-reviews.js の終了コード（不明な場合は1）
 */
function spawnPollReviews(pr, workspace, sessionPid, intervalSeconds = 30, onOutputLine) {
  const args = [path.join(__dirname, 'poll-reviews.js'), pr, workspace, String(intervalSeconds), '--session-pid', String(sessionPid)];
  let child;
  try {
    child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
  } catch {
    return Promise.resolve(1);
  }

  if (child && child.stdout && typeof child.stdout.on === 'function') {
    let buffer = '';
    const relayLine = (line) => {
      process.stdout.write(`${line}\n`);
      if (onOutputLine) onOutputLine(line);
    };
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        relayLine(buffer.slice(0, newlineIndex).replace(/\r$/, ''));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');
      }
    });
    child.stdout.on('end', () => {
      if (buffer) relayLine(buffer.replace(/\r$/, ''));
      buffer = '';
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      resolve(typeof code === 'number' ? code : 1);
    };
    child.on('close', finish);
    child.on('error', () => finish(1));
  });
}

function parsePrPushLine(line) {
  if (typeof line !== 'string' || !line.startsWith('PR_PUSH:')) return null;
  const headSha = line.slice('PR_PUSH:'.length).trim();
  return /^[0-9a-fA-F]{7,40}$/.test(headSha) ? headSha : null;
}

function getPrHead(pr, repo) {
  const r = spawnSync('gh', ['pr', 'view', pr, '--repo', repo,
    '--json', 'headRefOid', '-q', '.headRefOid'], { encoding: 'utf8' });
  if (!r || r.status !== 0) {
    console.error('poll-pr: PR #' + pr + ' のHEAD取得に失敗しました（gh pr view）: ' + ((r && r.stderr) || '').toString().trim());
    return '';
  }
  const head = (r.stdout || '').toString().trim();
  return /^[0-9a-fA-F]{7,40}$/.test(head) ? head : '';
}

const SLOW_TEST_TIMEOUT_MS = 30 * 60 * 1000;
const SLOW_UNKNOWN_HEAD_KEY = 'head-unavailable';

function slowStatePath(workspace, pr) {
  if (!/^[0-9]+$/.test(String(pr))) throw new Error(`PR番号が不正です: ${pr}`);
  return path.join(workspace, '.gh-maestro', `poll-slow-test-${String(pr)}.json`);
}

function readSlowState(statePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || !parsed.runs || typeof parsed.runs !== 'object' || Array.isArray(parsed.runs)) {
      throw new Error('slow state format is invalid');
    }
    return parsed;
  } catch (error) {
    if (error && error.code === 'ENOENT') return { schemaVersion: 1, runs: {} };
    throw error;
  }
}

function withSlowStateLock(statePath, action) {
  const lockPath = `${statePath}.lock`;
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  let fd;
  try { fd = fs.openSync(lockPath, 'wx'); } catch (error) { throw new Error(`slow state lock is unavailable: ${error.message}`); }
  try { return action(); } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lockPath); } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
  }
}

function reserveSlowRun(workspace, pr, headSha, now = new Date().toISOString()) {
  const statePath = slowStatePath(workspace, pr);
  const runKey = headSha || SLOW_UNKNOWN_HEAD_KEY;
  return withSlowStateLock(statePath, () => {
    const state = readSlowState(statePath);
    const existing = state.runs[runKey];
    if (existing) return { statePath, runKey, existing, reserved: false };
    state.schemaVersion = 1;
    state.pr = String(pr);
    state.layer = 'slow';
    state.runs[runKey] = {
      status: 'running',
      startedAt: now,
      ...(headSha ? { testedHead: headSha } : {}),
    };
    atomicWriteJson(statePath, state);
    return { statePath, runKey, existing: state.runs[runKey], reserved: true };
  });
}

function updateSlowRun(statePath, runKey, update) {
  return withSlowStateLock(statePath, () => {
    const state = readSlowState(statePath);
    if (!state.runs[runKey]) throw new Error(`slow state run is missing: ${runKey}`);
    state.runs[runKey] = { ...state.runs[runKey], ...update };
    atomicWriteJson(statePath, state);
    return state.runs[runKey];
  });
}

function resolveSlowWorktree(workspace, issue) {
  const raw = readWorkersRaw(workspace);
  if (!raw) throw new Error(`workers.json を読み込めません（${workspace}）`);
  let skill = null;
  for (const candidate of ['gh-maestro-senior-coder', 'gh-maestro-coder']) {
    try {
      resolveWorkerName(workspace, { issue, skill: candidate });
      skill = candidate;
      break;
    } catch (error) {
      if (String(error.message).includes('複数のワーカー')) throw error;
    }
  }
  if (!skill) throw new Error(`slow層の対象ワーカーが見つかりません（issue=${issue}）`);
  const workerName = resolveWorkerName(workspace, { issue, skill });
  const worktree = path.join(workspace, '.gh-maestro', 'worktrees', workerName);
  if (!fs.existsSync(worktree) || !fs.statSync(worktree).isDirectory()) {
    throw new Error(`slow層の対象worktreeが見つかりません: ${worktree}`);
  }
  return { workerName, worktree };
}

function sameHead(actual, expected) {
  return Boolean(actual && expected && (actual.toLowerCase() === expected.toLowerCase()
    || actual.toLowerCase().startsWith(expected.toLowerCase())
    || expected.toLowerCase().startsWith(actual.toLowerCase())));
}

function emitSlowResult(pr, result) {
  process.stdout.write(`SLOW_TEST_RESULT:${JSON.stringify({ pr: String(pr), layer: 'slow', ...result })}\n`);
}

function unavailableSlowLayer(headSha, logPath, reason) {
  return {
    layer: 'slow',
    scope: 'partial',
    status: 'unavailable',
    command: 'npm run test:slow',
    recordedAt: new Date().toISOString(),
    testedHead: headSha,
    executor: 'poll-pr',
    executionLogPath: logPath,
    reason,
  };
}

function slowLogPath(workspace, pr, headSha) {
  const token = headSha || SLOW_UNKNOWN_HEAD_KEY;
  return path.join(workspaceRuntimeDir(workspace), 'test-results', `slow-pr-${String(pr)}-${token}.log`);
}

function appendSlowFailureLog(logPath, reason) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `[gh-maestro slow unavailable] ${new Date().toISOString()}\n${reason}\n`, 'utf8');
  return logPath;
}

function closeLogFd(logFd) {
  if (logFd === null || logFd === undefined) return;
  try { fs.closeSync(logFd); } catch {}
}

function writeUnavailableLayer(target, headSha, logPath, reason, deps = {}) {
  if (!target || !target.worktree) return null;
  const writeLayerFn = deps.writeTestResultLayerFn || writeTestResultLayer;
  const testResultPathFn = deps.testResultPathFn || testResultPath;
  try {
    writeLayerFn(target.worktree, unavailableSlowLayer(headSha, logPath, reason));
    return testResultPathFn(target.worktree);
  } catch {
    return null;
  }
}

function declareSlowResult({ pr, repo, workspace, target, headSha, statePath, runKey }, deps = {}) {
  if (!target || !target.worktree || !headSha) return;
  const declareFn = deps.declareTestResultFn || declareTestResult;
  try {
    const declared = declareFn({ pr, repo, workspace, worktree: target.worktree, headSha });
    updateSlowRun(statePath, runKey, {
      declaration: declared.ok ? 'updated' : 'failed',
      ...(declared.ok ? {} : { declarationError: declared.error }),
    });
  } catch (error) {
    try { updateSlowRun(statePath, runKey, { declaration: 'failed', declarationError: error.message }); } catch {}
  }
}

function finishSlowFailure({ pr, repo, workspace, target, headSha, statePath, runKey, logPath, child, reason, closeLog }, deps = {}) {
  if (child && child.pid) {
    try { killProcessTree(child.pid); } catch {}
  }
  if (closeLog) closeLog();
  const resolvedLogPath = logPath || slowLogPath(workspace, pr, headSha);
  let logError;
  try { appendSlowFailureLog(resolvedLogPath, reason); } catch (error) { logError = error.message; }
  const artifactPath = writeUnavailableLayer(target, headSha, resolvedLogPath, reason, deps)
    || (statePath && fs.existsSync(statePath) ? statePath : resolvedLogPath);
  const result = {
    status: 'unavailable',
    ...(headSha ? { testedHead: headSha } : {}),
    executionLogPath: resolvedLogPath,
    artifactPath,
    statePath,
    error: reason,
    ...(logError ? { logError } : {}),
  };
  if (statePath && runKey) {
    try {
      updateSlowRun(statePath, runKey, {
        status: 'unavailable',
        completedAt: new Date().toISOString(),
        logPath: resolvedLogPath,
        result,
        ...(logError ? { logError } : {}),
      });
    } catch (error) {
      result.stateError = error.message;
    }
  }
  emitSlowResult(pr, result);
  declareSlowResult({ pr, repo, workspace, target, headSha, statePath, runKey }, deps);
  return result;
}

function finishSlowStale({ pr, workspace, target, headSha, statePath, runKey, logPath, reason }) {
  let artifactPath = statePath || logPath;
  if (target && target.worktree) {
    try { artifactPath = testResultPath(target.worktree); } catch {}
  }
  const result = {
    status: 'unavailable',
    ...(headSha ? { testedHead: headSha } : {}),
    executionLogPath: logPath,
    artifactPath,
    statePath,
    error: reason,
  };
  if (statePath && runKey) {
    try {
      updateSlowRun(statePath, runKey, {
        status: 'unavailable',
        completedAt: new Date().toISOString(),
        logPath,
        result,
      });
    } catch (error) {
      result.stateError = error.message;
    }
  }
  emitSlowResult(pr, result);
  return result;
}

function finishSlowRun({ pr, repo, workspace, target, headSha, statePath, runKey, logPath, exitCode }, deps = {}) {
  const readArtifactFn = deps.readTestResultArtifactFn || readTestResultArtifact;
  const writeLayerFn = deps.writeTestResultLayerFn || writeTestResultLayer;
  let read = readArtifactFn(target.worktree);
  const layer = read.ok && read.result.scope === 'aggregate' ? read.result.layers.slow : null;
  if (!layer || !sameHead(layer.testedHead, headSha)) {
    try {
      writeLayerFn(target.worktree, unavailableSlowLayer(
        headSha,
        logPath,
        exitCode === 0 ? 'slow-result-missing' : 'runner-abnormal-exit',
      ));
    } catch {}
  }
  read = readArtifactFn(target.worktree);
  const finalLayer = read.ok && read.result.scope === 'aggregate' && read.result.layers.slow
    ? read.result.layers.slow : unavailableSlowLayer(headSha, logPath, 'slow-result-unavailable');
  const status = finalLayer.status === 'complete' ? finalLayer.outcome : 'unavailable';
  const result = {
    status,
    ...(finalLayer.outcome !== undefined ? { outcome: finalLayer.outcome } : {}),
    exitCode,
    testedHead: headSha,
    ...(finalLayer.tests !== undefined ? { tests: finalLayer.tests } : {}),
    ...(finalLayer.pass !== undefined ? { pass: finalLayer.pass } : {}),
    ...(finalLayer.fail !== undefined ? { fail: finalLayer.fail } : {}),
    executionLogPath: finalLayer.executionLogPath || logPath,
    artifactPath: read.path || testResultPath(target.worktree),
    statePath,
  };
  try {
    updateSlowRun(statePath, runKey, { status, completedAt: new Date().toISOString(), exitCode, result });
  } catch (error) {
    result.stateError = error.message;
  }
  emitSlowResult(pr, result);
  declareSlowResult({ pr, repo, workspace, target, headSha, statePath, runKey }, deps);
  return result;
}

async function executeSlowChild({ target, logPath, childEnv, onSpawn }, deps = {}) {
  const spawnFn = deps.spawnFn || spawn;
  const waitChildExitFn = deps.waitChildExitFn || waitChildExit;
  let logFd;
  let child;
  const closeLog = () => {
    closeLogFd(logFd);
    logFd = null;
  };
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    logFd = fs.openSync(logPath, 'a');
    child = spawnFn(process.execPath, [path.join(__dirname, 'run-tests.js'), '--workspace', target.worktree, 'slow'], {
      cwd: target.worktree,
      env: childEnv,
      stdio: ['ignore', logFd, logFd],
    });
    if (onSpawn) onSpawn(child);
    const exitCode = await waitChildExitFn({
      child,
      timeoutMs: SLOW_TEST_TIMEOUT_MS,
      onCleanup: closeLog,
    });
    closeLog();
    return { exitCode, child: null, closeLog };
  } catch (error) {
    closeLog();
    error.child = child;
    throw error;
  }
}

function recordHeadUnavailable({ pr, repo, workspace, reason }, deps = {}) {
  const statePath = slowStatePath(workspace, pr);
  let reservation;
  try {
    reservation = reserveSlowRun(workspace, pr, null);
  } catch (error) {
    return finishSlowFailure({
      pr, repo, workspace, statePath, reason: `${reason}; state reservation failed: ${error.message}`,
    }, deps);
  }
  if (!reservation.reserved) {
    const result = reservation.existing.result || {
      status: reservation.existing.status,
      artifactPath: statePath,
      statePath,
      executionLogPath: reservation.existing.logPath || slowLogPath(workspace, pr, null),
    };
    emitSlowResult(pr, result);
    return result;
  }
  return finishSlowFailure({
    pr,
    repo,
    workspace,
    statePath: reservation.statePath,
    runKey: reservation.runKey,
    reason,
  }, deps);
}

async function runSlowTest({ pr, issue, repo, workspace, headSha }, deps = {}) {
  let statePath;
  const runKey = headSha || SLOW_UNKNOWN_HEAD_KEY;
  let target;
  let logPath;
  let child;
  let closeLog;
  try {
    statePath = slowStatePath(workspace, pr);
    const reservation = reserveSlowRun(workspace, pr, headSha);
    if (!reservation.reserved) {
      const result = reservation.existing.result || {
        status: reservation.existing.status,
        ...(headSha ? { testedHead: headSha } : {}),
        artifactPath: statePath,
        statePath,
        executionLogPath: reservation.existing.logPath,
      };
      process.stdout.write(`SLOW_TEST_ALREADY_RECORDED:${JSON.stringify({ pr: String(pr), layer: 'slow', ...(headSha ? { testedHead: headSha } : {}), status: reservation.existing.status })}\n`);
      return result;
    }
    if (deps.onReserved) deps.onReserved({ pr: String(pr), layer: 'slow', testedHead: headSha });
    const resolveWorktreeFn = deps.resolveSlowWorktreeFn || resolveSlowWorktree;
    const resolveHeadFn = deps.resolveGitHeadFn || resolveGitHead;
    target = resolveWorktreeFn(workspace, issue);
    const localHead = resolveHeadFn(target.worktree);
    if (!sameHead(localHead, headSha)) throw new Error(`PR HEADとslow対象worktreeのHEADが不一致です: ${localHead || '(empty)'} != ${headSha}`);
    logPath = slowLogPath(target.worktree, pr, headSha);
    const childEnv = {
      ...process.env,
      GH_MAESTRO_WORKSPACE: target.worktree,
      GH_MAESTRO_TEST_ACTOR: 'poll-pr',
      GH_MAESTRO_TEST_LOG_PATH: logPath,
    };
    const childResult = await executeSlowChild({
      target,
      logPath,
      childEnv,
      onSpawn: (spawned) => {
        child = spawned;
        updateSlowRun(statePath, runKey, { pid: spawned.pid || null, logPath });
      },
    }, deps);
    child = childResult.child;
    closeLog = childResult.closeLog;
    let finalLocalHead = '';
    try { finalLocalHead = resolveHeadFn(target.worktree); } catch {}
    if (!sameHead(finalLocalHead, headSha)) {
      return finishSlowStale({
        pr,
        workspace,
        target,
        headSha,
        statePath,
        runKey,
        logPath,
        reason: `slow対象worktreeのHEADが実行中に変更されました: ${finalLocalHead || '(empty)'} != ${headSha}`,
      });
    }
    return finishSlowRun({
      pr, repo, workspace, target, headSha, statePath, runKey, logPath, exitCode: childResult.exitCode,
    }, deps);
  } catch (error) {
    return finishSlowFailure({
      pr,
      repo,
      workspace,
      target,
      headSha,
      statePath,
      runKey,
      logPath,
      child: error.child || child,
      closeLog,
      reason: error && error.message ? error.message : 'slow-run-failed',
    }, deps);
  }
}


/**
 * gh 経由でPRのベースブランチ名を取得する。
 * @param {string} pr
 * @param {string} repo
 * @returns {string} ベースブランチ名、取得失敗時は空文字列
 */
function getPrBaseBranch(pr, repo) {
  const r = spawnSync('gh', ['pr', 'view', pr, '--repo', repo,
    '--json', 'baseRefName', '-q', '.baseRefName'], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error('poll-pr: PR #' + pr + ' のベースブランチ取得に失敗しました（gh pr view）: ' + (r.stderr || '').toString().trim());
    return '';
  }
  return (r.stdout || '').trim();
}

/**
 * gh 経由でPRの state を取得する。
 * @param {string} pr
 * @param {string} repo
 * @returns {string} PR状態（'OPEN'|'CLOSED'|'MERGED' 等）。取得失敗時は空文字列（fail-closed）
 */
function getPrState(pr, repo) {
  const r = spawnSync('gh', ['pr', 'view', pr, '--repo', repo,
    '--json', 'state', '-q', '.state'], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error('poll-pr: PR #' + pr + ' の状態取得に失敗しました（gh pr view）: ' + (r.stderr || '').toString().trim());
    return '';
  }
  return (r.stdout || '').trim();
}

/**
 * poll-reviews.js 終了後の続行判断（純粋関数）。
 *
 * 却下・キャンセルで CLOSED された PR はマージ待ちではないため、新 PR 検出（findPR）へ復帰する。
 * ただし復帰できるのは、子プロセス（poll-reviews.js）が正常終了（exit 0）した場合に限る。
 * 子が非ゼロ終了・シグナル終了（SIGKILL等）した場合は、SIGKILLでは子自身の exit 通知が実行
 * できず監視停止が誰にも届かないため、PR状態に関わらず親も exit に倒して異常を表面化させる
 * （Issue #289 受け入れ条件3）。親が非ゼロで終了することで、親自身の exit 通知
 * （notifyWatchdogExit）が監視停止を待機側へ届ける。
 * それ以外（MERGED 含む）はプロセスを終了する。状態が取得できない空文字列は fail-closed で
 * exit に倒す（poll-reviews の異常終了を勝手に新PR監視で隠蔽しない。異常は exit 通知で表面化する）。
 *
 * @param {string} prState PRのstate（空文字列は取得失敗）
 * @param {number} exitCode poll-reviews.js の終了コード（0 は正常終了）
 * @returns {'resume' | 'exit'}
 */
function resolvePostReviewDecision(prState, exitCode) {
  if (exitCode !== 0) return 'exit';
  return prState === 'CLOSED' ? 'resume' : 'exit';
}

/**
 * MERGED確認時の打刻とスナップショット投稿。両方ともbest-effortで、
 * poll-pr本体の終了判断・終了コードには影響させない。
 */
function recordMergeAndSnapshot({ prState, issue, pr, repo, workspace, exitCode }, deps = {}) {
  if (prState !== 'MERGED') return { merged: false };
  const recordCycleEventFn = deps.recordCycleEventFn || recordCycleEvent;
  const postCycleSnapshotFn = deps.postCycleSnapshotFn || postCycleSnapshot;
  const warnings = [];
  try {
    recordCycleEventFn(workspace, issue, 'merged', { pr });
  } catch (error) {
    warnings.push(`merged event: ${error.message}`);
  }
  try {
    postCycleSnapshotFn({ issue, pr, repo, workspace }, deps.snapshotDeps || {});
  } catch (error) {
    warnings.push(`cycle snapshot: ${error.message}`);
  }
  return { merged: true, exitCode, warnings };
}

/**
 * PR検出時にベースブランチの不一致を検出する（純粋関数）。
 * @param {string} expectedBaseBranch --base-branch で指定された想定ブランチ
 * @param {string} actualBaseBranch   PRの実際のベースブランチ
 * @param {string} pr                 PR番号
 * @returns {string|null} 不一致時は PR_BASE_MISMATCH 行、一致時は null
 */
function formatBaseBranchMismatch(expectedBaseBranch, actualBaseBranch, pr) {
  if (!expectedBaseBranch) return null;
  // 実際のベースブランチが取得できない場合は (unknown) として報告（fail-closed）
  if (!actualBaseBranch) return 'PR_BASE_MISMATCH:' + pr + ':' + expectedBaseBranch + ':(unknown)';
  if (expectedBaseBranch === actualBaseBranch) return null;
  return 'PR_BASE_MISMATCH:' + pr + ':' + expectedBaseBranch + ':' + actualBaseBranch;
}

module.exports = {
  getPrHead,
  getPrBaseBranch,
  formatBaseBranchMismatch,
  getPrState,
  resolvePostReviewDecision,
  recordMergeAndSnapshot,
  spawnPollReviews,
  parsePrPushLine,
  slowStatePath,
  reserveSlowRun,
  resolveSlowWorktree,
  runSlowTest,
  recordHeadUnavailable,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  let values, rest;
  try {
    ({ values, rest } = parseFlags(argv, {
      flags: { '--workspace': {}, '--session-pid': {}, '--base-branch': {} },
      booleans: ['--no-review-manager', '--help', '-h'],
      // issue（必須）と interval（任意）の2つまで。未知フラグ・余剰位置引数はパーサ側で拒否される
      // （Issue #14 / argv-parsing-pitfalls）。
      positionals: { min: 1, max: 2 },
    }));
  } catch (err) {
    if (err.name !== 'ArgsValidationError') throw err;
    if (err.helpRequested) {
      console.log(USAGE);
      process.exit(0);
    }
    for (const e of err.errors) console.error(`poll-pr: ${e.message}`);
    console.error(USAGE);
    process.exit(1);
  }

  if (values['--help'] || values['-h']) {
    console.log(USAGE);
    process.exit(0);
  }

  const workspaceArg = values['--workspace'];
  const sessionPidArg = values['--session-pid'];
  const baseBranch = values['--base-branch'];
  const noReviewManager = values['--no-review-manager'] === true;

  const [issue, intervalArg] = rest;

  const interval = parseInt(intervalArg || '30') * 1000;

  const workspace = resolveWorkspace(workspaceArg);
  if (!workspace) {
    console.error('poll-pr: ワークスペースを解決できません。--workspace を指定するか、.gh-maestro/ のあるディレクトリで実行してください。');
    process.exit(1);
  }

  const repo = spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
    { encoding: 'utf8', cwd: workspace }).stdout.trim();

  // ── ライフサイクル管理 ─────────────────────────────────────────────────

  const sessionPid = resolveSessionPid(sessionPidArg);

  // PID再利用検知のため、起動時に親セッションの起動時刻を捕捉する（best-effort。
  // 取得失敗時は expectedStartTime=null となり isProcessAlive のみの従来判定にフォールバック）。
  const expectedStartTime = getProcessStartTime(sessionPid);
  const checkParent = createDeadManSwitch(sessionPid, { expectedStartTime });

  // PID registry に自己登録
  registerProcess(workspace, { script: 'poll-pr.js' });

  // cleanup: registry 解除 + exit
  function cleanup(code = 0) {
    lifecycleCleanup(workspace);
    process.exit(code);
  }

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // 異常終了（非ゼロexit）を orchestrator へ通知する（Issue #289 受け入れ条件3）。
  // 正常終了（exit 0: SIGINT/SIGTERM/親セッション消滅/MERGED/CLOSED）では何もしない。
  // process.on('exit') は同期コードしか実行できないため、共有ヘルパーは spawnSync で
  // 同期投稿する（best-effort・throwしない）。
  // 通知先は手元にあるこの監視対象 Issue を明示する。workers.json の先頭ワーカー推測
  // フォールバックに落とすと、別 Issue へ誤配送されたり宛先不明で破棄されたりして
  // 監視停止が待機側へ届かない（Issue #289 レビュー指摘）。orchestrator に確実に届ける。
  process.on('exit', () => { notifyWatchdogExit({ workspace, scriptName: 'poll-pr.js', issue }); });

  function findPR() {
    let r = spawnSync('gh', ['pr', 'list', '--repo', repo,
      '--search', `head:issue-${issue}`, '--state', 'open',
      '--json', 'number', '-q', '.[0].number'], { encoding: 'utf8' });
    const pr = r.stdout.trim();
    if (pr) return pr;

    r = spawnSync('gh', ['pr', 'list', '--repo', repo, '--state', 'open',
      '--json', 'number,body', '-q',
      `.[] | select(.body | strings | contains("#${issue}")) | .number`],
      { encoding: 'utf8' });
    return r.stdout.trim().split('\n').find(s => s.trim()) || '';
  }

  const pendingSlowTests = new Set();
  const slowQueues = new Map();

  function queueSlowTask(pr, operation) {
    const queueKey = String(pr);
    const previous = slowQueues.get(queueKey) || Promise.resolve();
    const task = previous.catch(() => {}).then(operation);
    slowQueues.set(queueKey, task);
    pendingSlowTests.add(task);
    const remove = () => {
      pendingSlowTests.delete(task);
      if (slowQueues.get(queueKey) === task) slowQueues.delete(queueKey);
    };
    task.then(remove, remove);
    return task;
  }

  function launchSlowTest(pr, suppliedHeadSha) {
    const headSha = suppliedHeadSha || getPrHead(pr, repo);
    if (!headSha) {
      queueSlowTask(pr, () => recordHeadUnavailable({
        pr,
        repo,
        workspace,
        reason: 'pr-head-unavailable',
      }));
      return;
    }
    queueSlowTask(pr, () => runSlowTest(
      { pr, issue, repo, workspace, headSha },
      {
        onReserved: ({ testedHead }) => {
          process.stdout.write(`SLOW_TEST_STARTED:${JSON.stringify({ pr: String(pr), layer: 'slow', testedHead })}\n`);
        },
      },
    ));
  }

  (async () => {
    while (true) {
      // dead-man's switch: 親セッション生存確認
      if (!checkParent()) {
        console.error(`poll-pr: parent session (pid ${sessionPid}) is dead — exiting`);
        cleanup();
        return; // unreachable（cleanup が process.exit する）
      }

      const pr = findPR();
      if (pr) {
        // ベースブランチ検証: --base-branch が指定されていれば検出したPRの
        // 実際のベースブランチと比較し、不一致なら警告を出力する（処理は継続）。
        if (baseBranch) {
          const actualBase = getPrBaseBranch(pr, repo);
          const mismatch = formatBaseBranchMismatch(baseBranch, actualBase, pr);
          if (mismatch) {
            process.stdout.write(mismatch + "\n");
          }
        }

        process.stdout.write(`PR_DETECTED:${pr}\n`);

        // slow層はレビュー監視の子を同期的に待たせない。対象HEADごとの予約を先に
        // runtime状態へ記録し、同じPR/commit/layerでは再起動後も二重実行しない。
        launchSlowTest(pr);

        // --no-review-manager のときは Review Manager を起動せず、レビュー監視だけを再開する。
        if (!noReviewManager) {
          // 常に全観点で起動する。観点を絞り込むかどうかの判断は
          // Review Manager自身が実際のdiffを見た上で行う（skills/gh-maestro-reviewer/SKILL.md参照）。
          // オーケストレーター側・本スクリプト側でファイルパターン等から機械的に観点を
          // 決定することは行わない。
          // 起動後のクラッシュはここでは判定しない（終了フック経由でIssueコメントとして
          // 非同期に通知される。start-review-manager.js参照）。本スクリプトはそれを待たず
          // 常にPR/レビュー監視（poll-reviews.js）へ進む。
          const reviewStatus = startReviewManager(pr, repo, workspace, issue);
          process.stdout.write(`${reviewStatus}:${pr}\n`);
        }

        // poll-pr.js と poll-reviews.js は内部ロジックを統合せず、それぞれ独立に保つ。
        // 代わりにここで poll-reviews.js を子プロセスとして起動し、終了まで中継する（Issue #111）。
        const exitCode = await spawnPollReviews(
          pr,
          workspace,
          sessionPid,
          intervalArg || '30',
          (line) => {
            const pushedHead = parsePrPushLine(line);
            if (pushedHead) launchSlowTest(pr, pushedHead);
          },
        );
        // レビュー監視が先に終わっても、slowの完了通知と成果物・申告更新を回収してから
        // poll-prを終了する。slowの実行中にレビュー監視を止めることはない。
        if (pendingSlowTests.size > 0) await Promise.all([...pendingSlowTests]);
        // poll-reviews.js が終了したあと、PR の実状態を inspect して続行判断する（declare-and-inspect）。
        // PR状態に加えて子の終了コードも見る：子が非ゼロ終了・シグナル終了した場合は PR状態が
        // CLOSED でも復帰せず、親も非ゼロで終了して異常を通知する（Issue #289 受け入れ条件3。
        // SIGKILL等で子自身の exit 通知が実行できなくても、親の exit 通知が監視停止を届ける）。
        const prState = getPrState(pr, repo);
        recordMergeAndSnapshot({ prState, issue, pr, repo, workspace, exitCode });
        if (resolvePostReviewDecision(prState, exitCode) === 'resume') {
          // 子が正常終了し、かつ却下・キャンセルで CLOSED された PR を掴んだまま無言で
          // 居座り続けない（Issue #289）。findPR ループへ戻り、新 PR の検出を継続する。
          process.stdout.write(`PR_CLOSED_RESUMED:${pr}\n`);
          continue;
        }
        cleanup(exitCode);
        return; // unreachable
      }
      await new Promise(r => setTimeout(r, interval));
    }
  })();
}

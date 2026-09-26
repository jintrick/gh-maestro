#!/usr/bin/env node
'use strict';

// poll-pr-monitor.js — plugin monitor 用の固定コマンド。
//
// plugin monitor はコマンドへ Issue 番号を渡せないため、PR監視の実体は runtime の
// pr-monitor-target.json を読み、可変の poll-pr.js を子プロセスとして起動する。
// 同じ generation の子を再試行しない。target の削除・切替時だけ親子をまとめて停止し、
// poll-pr.js の slow state 回収を実行する。

const path = require('path');
const { spawn } = require('./shared/child-process');
const { killProcessTree } = require('./shared/kill-tree');
const { resolveWorkspace, parseFlags } = require('./shared/workspace');
const {
  resolveSessionPid,
  getProcessStartTime,
  isProcessAlive,
  startTimesMatch,
} = require('./process-lifecycle');
const { readPrMonitorTarget } = require('./shared/pr-monitor-target');
const { recoverOrphanedSlowRuns } = require('./poll-pr');

const DEFAULT_INTERVAL_MS = 1000;
const CHILD_STOP_TIMEOUT_MS = 5000;

const USAGE = `poll-pr-monitor.js — plugin monitor の固定コマンド（通常は直接起動しない）

Usage: node poll-pr-monitor.js --plugin-monitor --workspace <path>

Options:
  --plugin-monitor      plugin monitor からの起動を明示する
  --workspace <path>    ワークスペースパス
  --help, -h            このヘルプを表示する`;

function waitForChildClose(child, timeoutMs = CHILD_STOP_TIMEOUT_MS) {
  if (!child || (child.exitCode !== null && child.exitCode !== undefined)) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    if (typeof child.once === 'function') {
      child.once('close', finish);
      child.once('exit', finish);
      child.once('error', finish);
    }
    setTimeout(finish, timeoutMs);
  });
}

function childArguments(target, workspace, sessionPid) {
  const args = [
    path.join(__dirname, 'poll-pr.js'),
    String(target.issue),
    '--workspace', workspace,
    '--plugin-monitor',
  ];
  if (sessionPid) args.push('--session-pid', String(sessionPid));
  if (target.baseBranch) args.push('--base-branch', target.baseBranch);
  if (target.noReviewManager) args.push('--no-review-manager');
  if (target.noReviewEvents) args.push('--no-review-events');
  return args;
}

function spawnTarget(target, workspace, sessionPid, deps = {}) {
  const spawnFn = deps.spawnFn || spawn;
  const writeStdoutFn = deps.writeStdoutFn || ((chunk) => process.stdout.write(chunk));
  const writeStderrFn = deps.writeStderrFn || ((chunk) => process.stderr.write(chunk));
  const child = spawnFn(process.execPath, childArguments(target, workspace, target.sessionPid || sessionPid), {
    cwd: workspace,
    env: { ...process.env, GH_MAESTRO_WORKSPACE: workspace },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0) {
    throw new Error('poll-pr.js のspawn結果から有効なPIDを取得できません');
  }

  const state = { child, target, done: false, exitCode: null, error: null };
  const finish = (code) => {
    if (state.done) return;
    state.done = true;
    state.exitCode = Number.isInteger(code) ? code : 1;
  };
  if (child.stdout && typeof child.stdout.on === 'function') {
    child.stdout.on('data', (chunk) => writeStdoutFn(chunk));
  }
  if (child.stderr && typeof child.stderr.on === 'function') {
    child.stderr.on('data', (chunk) => writeStderrFn(chunk));
  }
  if (typeof child.once === 'function') {
    child.once('error', (error) => {
      state.error = error;
      writeStderrFn(`poll-pr-monitor: poll-pr.js の起動後エラー: ${error.message}\n`);
      finish(1);
    });
    child.once('exit', (code) => finish(code));
    child.once('close', (code) => finish(code));
  }
  return state;
}

async function stopTarget(active, deps = {}) {
  if (!active) return;
  if (!active.done && active.child && active.child.pid) {
    try { (deps.killProcessTreeFn || killProcessTree)(active.child.pid); } catch (error) {
      (deps.writeStderrFn || ((chunk) => process.stderr.write(chunk)))
        (`poll-pr-monitor: poll-pr.js の停止に失敗しました: ${error.message}\n`);
    }
  }
  await (deps.waitForChildCloseFn || waitForChildClose)(active.child, deps.childStopTimeoutMs);
}

function sessionIsAlive(sessionPid, expectedStartTime, deps = {}) {
  if (!Number.isInteger(sessionPid) || sessionPid <= 0) return true;
  const aliveFn = deps.isProcessAliveFn || isProcessAlive;
  if (aliveFn(sessionPid) !== true) return false;
  if (!expectedStartTime) return true;
  const actual = (deps.getProcessStartTimeFn || getProcessStartTime)(sessionPid);
  return !actual || (deps.startTimesMatchFn || startTimesMatch)(expectedStartTime, actual);
}

async function runPrMonitor({ workspace, intervalMs = DEFAULT_INTERVAL_MS } = {}, deps = {}) {
  if (typeof workspace !== 'string' || workspace === '') throw new Error('poll-pr-monitor: workspace が必要です');
  const readTargetFn = deps.readTargetFn || readPrMonitorTarget;
  const sleepFn = deps.sleepFn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const recoverFn = deps.recoverOrphanedSlowRunsFn || recoverOrphanedSlowRuns;
  const writeStdoutFn = deps.writeStdoutFn || ((chunk) => process.stdout.write(chunk));
  const writeStderrFn = deps.writeStderrFn || ((chunk) => process.stderr.write(chunk));
  const maxIterations = deps.maxIterations === undefined ? Infinity : deps.maxIterations;
  const sessionPid = deps.sessionPid || (deps.resolveSessionPidFn || resolveSessionPid)();
  const expectedStartTime = deps.expectedStartTime === undefined
    ? ((deps.getProcessStartTimeFn || getProcessStartTime)(sessionPid))
    : deps.expectedStartTime;
  const checkSessionFn = deps.checkSessionFn || (() => sessionIsAlive(sessionPid, expectedStartTime, deps));
  let active = null;
  let finishedGeneration = null;
  let stopping = false;
  let iterations = 0;

  const recover = () => recoverFn(workspace, { writeStdoutFn });
  const stopActive = async () => {
    if (!active) return;
    const old = active;
    active = null;
    finishedGeneration = old.target.generation;
    await stopTarget(old, { ...deps, writeStderrFn });
    recover();
  };

  const onSignal = () => { stopping = true; };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    while (!stopping && iterations < maxIterations) {
      iterations += 1;
      if (!checkSessionFn()) {
        await stopActive();
        return { exitCode: 0, reason: 'session-ended' };
      }

      const target = readTargetFn(workspace);
      if (!target) {
        await stopActive();
        await sleepFn(intervalMs);
        continue;
      }

      if (active && active.target.generation !== target.generation) {
        await stopActive();
      }
      if (active && active.done) {
        if (active.exitCode !== 0) {
          writeStderrFn(
            `poll-pr-monitor: poll-pr.js が終了しました（code=${active.exitCode}; generation=${active.target.generation}）。` +
            '同じtargetでは自動再試行しません。\n'
          );
        }
        finishedGeneration = active.target.generation;
        active = null;
        recover();
      }
      if (!active && finishedGeneration !== target.generation) {
        try {
          active = spawnTarget(target, workspace, sessionPid, { ...deps, writeStdoutFn, writeStderrFn });
        } catch (error) {
          writeStderrFn(`poll-pr-monitor: poll-pr.js の起動に失敗しました: ${error.message}\n`);
          finishedGeneration = target.generation;
        }
      }
      await sleepFn(intervalMs);
    }
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (active) await stopActive();
  }
  return { exitCode: 0, reason: stopping ? 'stopped' : 'test-limit' };
}

function parseCli(argv) {
  try {
    const parsed = parseFlags(argv, {
      flags: { '--workspace': {} },
      booleans: ['--plugin-monitor', '--help', '-h'],
      positionals: { min: 0, max: 0 },
    });
    return { values: parsed.values, rest: parsed.rest, errors: [] };
  } catch (error) {
    if (error.name !== 'ArgsValidationError') throw error;
    return error.helpRequested ? { help: true, errors: [] } : { errors: error.errors };
  }
}

function run(argv = process.argv.slice(2), deps = {}) {
  const parsed = parseCli(argv);
  if (parsed.help || parsed.values?.['--help'] || parsed.values?.['-h']) {
    (deps.writeOut || console.log)(USAGE);
    return Promise.resolve(0);
  }
  if (parsed.errors && parsed.errors.length > 0) {
    for (const error of parsed.errors) (deps.writeErr || console.error)(`poll-pr-monitor: ${error.message}`);
    (deps.writeErr || console.error)(USAGE);
    return Promise.resolve(1);
  }
  const workspace = (deps.resolveWorkspaceFn || resolveWorkspace)(parsed.values['--workspace']);
  if (!workspace) {
    (deps.writeErr || console.error)('poll-pr-monitor: ワークスペースを解決できません。--workspace を指定してください');
    return Promise.resolve(1);
  }
  return runPrMonitor({ workspace }, deps).then(() => 0).catch((error) => {
    (deps.writeErr || console.error)(`poll-pr-monitor: ${error.message}`);
    return 1;
  });
}

module.exports = {
  USAGE,
  childArguments,
  parseCli,
  spawnTarget,
  stopTarget,
  runPrMonitor,
  run,
};

if (require.main === module) run().then((code) => { process.exitCode = code; });

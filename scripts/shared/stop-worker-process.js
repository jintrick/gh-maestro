'use strict';
// stop-worker-process.js — ワーカープロセスの同一性確認と停止を行う共通ヘルパー
//
// 提供する機能:
//   - workers.json から workerName のエントリを取得
//   - プロセスの同一性確認（verifyProcessIdentity）
//   - プロセスツリーの終了（killProcessTree）
//   - レガシー WezTerm pane / notifier の終了
//   - 関連する PID registry の sweep
//
// stop-worker.js（停止モード: isRemoveMode=false）および
// remove-worker.js（削除モード: isRemoveMode=true）のプロセス停止段で共通利用する。

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('./child-process');
const { killPane, getAlivePaneIds } = require('./pane-launch');
const { normalizeWorkerEntry } = require('./worker-entry');
const { killProcessTree, waitForPidsToExit } = require('./kill-tree');
const { sweepRegistry, isProcessAlive, verifyProcessIdentity } = require('../process-lifecycle');
const { deriveRoleFromSkill } = require('./worker-factory');
const { recordCycleEvent } = require('./cycle-metrics');
const { readWorkersRaw } = require('./workers-registry');
const { atomicWriteJson } = require('./atomic-write');

const defaultSleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function stopLegacyPane(paneId, options = {}) {
  const killPaneFn = options.killPaneFn || killPane;
  const result = killPaneFn(String(paneId));
  if (!result || result.ok !== true) {
    throw new Error(`レガシーpane ${paneId} のkill-pane 失敗: ${(result && result.stderr) || '(empty)'}`);
  }
  (options.sleepFn || defaultSleep)(options.sleepMs ?? 500);
  return result;
}

function validLegacyPaneId(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0;
  return typeof value === 'string' && /^\d+$/.test(value.trim());
}

/**
 * ワーカーのプロセスを同一性確認の上で停止する。
 *
 * @param {string} workspace ワークスペースのルートパス
 * @param {string} workerName 停止対象のワーカー名
 * @param {object} [opts]
 * @param {boolean} [opts.isRemoveMode=false] true の場合、同一性不一致時に throw せず警告を出して kill をスキップ
 * @param {(msg: string) => void} [opts.logWarn=console.warn] 警告・情報ログ出力関数
 * @param {(ms: number) => void} [opts.sleepFn=defaultSleep] pane解放待ちにも使うスリープ関数
 * @param {number} [opts.stopTimeoutMs=5000] プロセス停止確認の上限ミリ秒
 * @param {number} [opts.pollIntervalMs=50] プロセス停止確認の間隔ミリ秒
 * @param {number} [opts.sleepMs=500] レガシーpaneの解放待ちミリ秒
 * @param {Function} [opts.killProcessTreeFn] プロセス停止関数（テスト用）
 * @param {Function} [opts.waitForPidsToExitFn] 停止確認関数（テスト用）
 * @param {Function} [opts.isProcessAliveFn] 生存確認関数（テスト用）
 * @param {object} [opts._injectedWorkers] テスト用 workers オブジェクト注入
 * @returns {{ success: boolean, stoppedPid: number|null, skippedReason?: string, workerEntry: object }}
 */
function stopWorkerProcess(workspace, workerName, opts = {}) {
  const isRemoveMode = opts.isRemoveMode ?? false;
  const logWarn = opts.logWarn ?? console.warn;
  const sleepFn = opts.sleepFn ?? defaultSleep;
  const stopTimeoutMs = opts.stopTimeoutMs ?? 5000;
  const pollIntervalMs = opts.pollIntervalMs ?? 50;
  const paneWaitMs = opts.sleepMs ?? 500;
  const recordCycleEventFn = opts.recordCycleEventFn || recordCycleEvent;
  const killProcessTreeFn = opts.killProcessTreeFn || killProcessTree;
  const waitForPidsToExitFn = opts.waitForPidsToExitFn || waitForPidsToExit;
  const isProcessAliveFn = opts.isProcessAliveFn || isProcessAlive;

  const killAndConfirm = (pid) => {
    const killResult = killProcessTreeFn(pid, {
      timeoutMs: stopTimeoutMs,
      pollIntervalMs,
      sleepFn,
      isProcessAliveFn,
    });
    // WindowsではkillProcessTreeが親子孫全体を確認する。Unixでは同じAPIを
    // 親PIDにも適用して、少なくとも呼び出し元が停止完了を観測するまで返さない。
    const stopped = waitForPidsToExitFn(killResult?.pids || [pid], {
      timeoutMs: stopTimeoutMs,
      pollIntervalMs,
      sleepFn,
      isProcessAliveFn,
    });
    if (!stopped.ok) {
      throw new Error(
        `プロセスツリーの停止確認が期限内に完了しませんでした `
        + `(pid ${pid}, 残存PID: ${stopped.alivePids.join(',')})`,
      );
    }
    return killResult;
  };

  let workers = opts._injectedWorkers;
  if (!workers) {
    const workersJson = path.resolve(workspace, '.gh-maestro', 'workers.json');
    if (!fs.existsSync(workersJson)) {
      throw new Error(`workers.json が見つかりません: ${workersJson}`);
    }
    try {
      workers = JSON.parse(fs.readFileSync(workersJson, 'utf8'));
    } catch (e) {
      throw new Error(`workers.json のパースに失敗しました: ${e.message}`);
    }
  }

  if (!workers || typeof workers !== 'object' || !(workerName in workers)) {
    throw new Error(`ワーカー "${workerName}" のエントリが workers.json に見つかりません`);
  }

  const workerEntry = normalizeWorkerEntry(workers[workerName]);
  let stoppedPid = null;
  let skippedReason = null;

  // ── 後方互換: レガシーな detached notifier（poll-and-notify.js）を kill ──────
  if (workerEntry.notifierPid) {
    if (isProcessAliveFn(workerEntry.notifierPid)) {
      killAndConfirm(workerEntry.notifierPid);
      logWarn(`stop-worker: レガシー notifier (pid ${workerEntry.notifierPid}) を終了しました`);
    } else {
      logWarn(`stop-worker: レガシー notifier (pid ${workerEntry.notifierPid}) は既に停止しています`);
    }
  }

  // ── headless ワーカーのプロセスツリーを終了（同一性確認付き） ──────────────────
  if (workerEntry.pid) {
    const pidAlive = isProcessAliveFn(workerEntry.pid);
    if (pidAlive) {
      const identity = verifyProcessIdentity(workerEntry.pid, workerEntry);
      if (!identity.match) {
        skippedReason = identity.reason || 'identity mismatch';
        if (isRemoveMode) {
          logWarn(`remove-worker: PID ${workerEntry.pid} の同一性確認に失敗しました (${identity.reason}) — プロセスは別プロセスに再利用されているため kill をスキップします`);
        } else {
          throw new Error(`ワーカー "${workerName}" のプロセス同一性確認に失敗しました（PID ${workerEntry.pid} は別プロセスに再利用されています: ${identity.reason}）。安全のためプロセス終了を中断します。`);
        }
      } else {
        killAndConfirm(workerEntry.pid);
        stoppedPid = workerEntry.pid;
        const prefix = isRemoveMode ? 'remove-worker' : 'stop-worker';
        logWarn(`${prefix}: ワーカープロセス (pid ${workerEntry.pid}) を終了しました`);
      }
    } else {
      const prefix = isRemoveMode ? 'remove-worker' : 'stop-worker';
      logWarn(`${prefix}: ワーカープロセス (pid ${workerEntry.pid}) は既に停止しています`);
    }
  }

  // ── 後方互換: 移行前セッションが残した WezTerm ペインを kill ──────────────
  if (workerEntry.paneId) {
    const prefix = isRemoveMode ? 'remove-worker' : 'stop-worker';
    try {
      stopLegacyPane(workerEntry.paneId, { sleepFn, sleepMs: paneWaitMs });
      logWarn(`${prefix}: レガシーpane ${workerEntry.paneId} を終了しました`);
    } catch (error) {
      logWarn(`${prefix}: レガシーpane ${workerEntry.paneId} のkill-pane 失敗: ${error.message}`);
    }
  }

  if (!workerEntry.pid && !workerEntry.paneId) {
    const prefix = isRemoveMode ? 'remove-worker' : 'stop-worker';
    logWarn(`${prefix}: ワーカー "${workerName}" に終了対象のプロセスが記録されていません`);
  }

  if (stoppedPid) {
    const issueMatch = /^issue-(\d+)-/.exec(workerName);
    const issue = workerEntry.issue || (issueMatch && issueMatch[1]);
    if (issue) {
      try {
        recordCycleEventFn(workspace, issue, 'worker-stopped', {
          workerName,
          role: workerEntry.skill ? deriveRoleFromSkill(workerEntry.skill) : undefined,
          skill: workerEntry.skill,
          agentId: workerEntry.agentId,
          pid: stoppedPid,
          startTime: workerEntry.startTime,
          abnormal: true,
        });
      } catch { /* best-effort */ }
    }
  }

  // ── PID registry sweep: ワーカーの登録PIDを同一性確認の上で kill ─────
  {
    const sweepResults = sweepRegistry(workspace, {
      match: (entry) => entry.workerName === workerName,
    });
    const prefix = isRemoveMode ? 'remove-worker' : 'stop-worker';
    if (sweepResults.killed.length > 0) {
      logWarn(`${prefix}: PID registry: ${sweepResults.killed.length} 件のプロセスを終了しました`);
      for (const k of sweepResults.killed) {
        logWarn(`${prefix}:   pid=${k.pid} script=${k.script || '-'}`);
      }
    }
    if (sweepResults.cleaned.length > 0) {
      logWarn(`${prefix}: PID registry: ${sweepResults.cleaned.length} 件のstaleエントリを掃除しました`);
    }
    for (const e of sweepResults.errors) {
      logWarn(`${prefix}: PID registry error: ${e}`);
    }
  }

  return {
    success: true,
    stoppedPid,
    skippedReason,
    workerEntry,
  };
}

/**
 * workers.jsonに残る旧paneIdだけを整理する。ワーカー本体のPIDやworktreeには触れない。
 * paneの存在を確認できない場合は、IDを再利用した無関係なpaneをkillしないため中断する。
 * @param {string} workspace
 * @param {object} [options]
 */
function cleanupLegacyWorkerPanes(workspace, options = {}) {
  const workersPath = path.resolve(workspace, '.gh-maestro', 'workers.json');
  const readWorkersFn = options.readWorkersFn || ((target) => {
    let stat;
    try {
      stat = fs.lstatSync(path.resolve(target, '.gh-maestro', 'workers.json'));
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('workers.json が通常ファイルではありません');
    }
    return readWorkersRaw(target);
  });
  const workers = readWorkersFn(workspace);
  if (workers === null) return { status: 'absent', path: workersPath, field: 'paneId' };
  if (!workers || typeof workers !== 'object' || Array.isArray(workers)) {
    throw new Error('workers.json はオブジェクトである必要があります');
  }

  const targets = [];
  for (const [name, rawEntry] of Object.entries(workers)) {
    if (name === 'orchestrator') continue;
    const isObject = rawEntry !== null && typeof rawEntry === 'object' && !Array.isArray(rawEntry);
    const rawPaneId = isObject ? rawEntry.paneId : rawEntry;
    if (rawPaneId === undefined || rawPaneId === null || rawPaneId === '') continue;
    if (!validLegacyPaneId(rawPaneId)) {
      throw new Error(`workers.json の ${name}.paneId は非負整数ではありません`);
    }
    targets.push({ name, rawEntry, isObject, paneId: String(rawPaneId) });
  }
  if (targets.length === 0) return { status: 'absent', path: workersPath, field: 'paneId' };

  let alivePanes = options.alivePanes;
  if (alivePanes === undefined) alivePanes = (options.getAlivePaneIdsFn || getAlivePaneIds)(options.warnFn || (() => {}));
  if (!(alivePanes instanceof Set)) throw new Error('legacy paneの生存一覧を確認できませんでした');
  const killed = [];
  const skipped = [];
  for (const target of targets) {
    if (alivePanes.has(target.paneId) || alivePanes.has(target.rawEntry)) {
      stopLegacyPane(target.paneId, {
        killPaneFn: options.killPaneFn,
        sleepFn: options.sleepFn,
        sleepMs: options.sleepMs ?? 0,
      });
      killed.push(target.paneId);
    } else {
      skipped.push(target.paneId);
    }
  }

  const nextWorkers = { ...workers };
  for (const { name, rawEntry, isObject } of targets) {
    nextWorkers[name] = isObject ? { ...rawEntry, paneId: null } : { paneId: null };
  }
  (options.atomicWriteFn || atomicWriteJson)(workersPath, nextWorkers);
  return {
    status: 'removed',
    path: workersPath,
    field: 'paneId',
    workers: targets.map(({ name }) => name),
    killedPanes: killed,
    skippedPanes: skipped,
  };
}

module.exports = { stopWorkerProcess, cleanupLegacyWorkerPanes, stopLegacyPane, validLegacyPaneId };

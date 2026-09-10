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
const { killPane } = require('./pane-launch');
const { normalizeWorkerEntry } = require('./worker-entry');
const { killProcessTree, waitForPidsToExit } = require('./kill-tree');
const { sweepRegistry, isProcessAlive, verifyProcessIdentity } = require('../process-lifecycle');
const { deriveRoleFromSkill } = require('./worker-factory');
const { recordCycleEvent } = require('./cycle-metrics');

const defaultSleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

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

  const killAndConfirm = (pid) => {
    const killResult = killProcessTree(pid, {
      timeoutMs: stopTimeoutMs,
      pollIntervalMs,
      sleepFn,
    });
    // WindowsではkillProcessTreeが親子孫全体を確認する。Unixでは同じAPIを
    // 親PIDにも適用して、少なくとも呼び出し元が停止完了を観測するまで返さない。
    const stopped = waitForPidsToExit(killResult?.pids || [pid], {
      timeoutMs: stopTimeoutMs,
      pollIntervalMs,
      sleepFn,
      isProcessAliveFn: isProcessAlive,
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
    if (isProcessAlive(workerEntry.notifierPid)) {
      killAndConfirm(workerEntry.notifierPid);
      logWarn(`stop-worker: レガシー notifier (pid ${workerEntry.notifierPid}) を終了しました`);
    } else {
      logWarn(`stop-worker: レガシー notifier (pid ${workerEntry.notifierPid}) は既に停止しています`);
    }
  }

  // ── headless ワーカーのプロセスツリーを終了（同一性確認付き） ──────────────────
  if (workerEntry.pid) {
    const pidAlive = isProcessAlive(workerEntry.pid);
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
    const killResult = killPane(workerEntry.paneId);
    const prefix = isRemoveMode ? 'remove-worker' : 'stop-worker';
    if (!killResult.ok) {
      logWarn(`${prefix}: レガシーpane ${workerEntry.paneId} のkill-pane 失敗: ${(killResult.stderr || '').trim()}`);
    } else {
      logWarn(`${prefix}: レガシーpane ${workerEntry.paneId} を終了しました`);
    }
    sleepFn(paneWaitMs);
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

module.exports = { stopWorkerProcess };
